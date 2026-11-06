import {
  MonarchError,
  NextThreadSuggestion,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Statement from "effect/sql/Statement";
import type * as SqlClient from "effect/sql/SqlClient";

const decodeSuggestion = Schema.decodeEffect(Schema.fromJsonString(NextThreadSuggestion));

export const validateSuggestionReferences = Effect.fn("MonarchService.validateReferences")(
  function* (
    sql: SqlClient.SqlClient,
    input: Pick<
      NextThreadSuggestion,
      "projectId" | "targets" | "sourceThreadIds" | "contextRevision"
    >,
  ) {
    if (input.contextRevision !== undefined) {
      const [context] = yield* sql<{
        revision: number;
      }>`SELECT revision FROM monarch_project_context WHERE project_id=${input.projectId}`;
      if ((context?.revision ?? 0) !== input.contextRevision)
        return yield* new MonarchError({ reason: "conflict" });
    }
    for (const reference of input.targets) {
      const [target] = yield* sql<{
        revision: number;
        status: string;
      }>`SELECT revision,json_extract(payload_json,'$.status') status
      FROM monarch_targets WHERE project_id=${input.projectId} AND id=${reference.targetId}`;
      if (!target) return yield* new MonarchError({ reason: "invalid_reference" });
      if (target.revision !== reference.revision || target.status !== "active")
        return yield* new MonarchError({ reason: "conflict" });
    }
    for (const threadId of input.sourceThreadIds) {
      const [source] = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
      WHERE thread_id=${threadId} AND project_id=${input.projectId} AND deleted_at IS NULL`;
      if (!source) return yield* new MonarchError({ reason: "invalid_reference" });
    }
  },
);

export const validateSuggestionUse = Effect.fn("MonarchService.validateSuggestionUse")(function* (
  sql: SqlClient.SqlClient,
  suggestion: NextThreadSuggestion,
) {
  if (suggestion.status !== "suggested")
    return yield* new MonarchError({ reason: "invalid_state" });
  const [project] =
    yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${suggestion.projectId} AND archived_at IS NULL AND deleted_at IS NULL`;
  if (!project) return yield* new MonarchError({ reason: "invalid_state" });
  if (suggestion.sourceThreadIds.length > 0) {
    const [excluded] =
      yield* sql`SELECT 1 FROM monarch_project_context c, json_each(c.settings_json, '$.excludedThreadIds') x
      WHERE c.project_id=${suggestion.projectId} AND x.value IN ${sql.in(suggestion.sourceThreadIds)} LIMIT 1`;
    if (excluded) return yield* new MonarchError({ reason: "invalid_reference" });
  }
  yield* validateSuggestionReferences(sql, suggestion);
});

export class ReservedSuggestionLaunchError extends Schema.TaggedError<ReservedSuggestionLaunchError>()(
  "ReservedSuggestionLaunchError",
  {
    message: Schema.String,
  },
) {}

const isReservedSuggestionLaunchError = Schema.is(ReservedSuggestionLaunchError);

export function reservedSuggestionErrorMessage(value: unknown): string | undefined {
  const seen = new Set<object>();
  while (value instanceof Error && !seen.has(value)) {
    if (isReservedSuggestionLaunchError(value)) return value.message;
    seen.add(value);
    value = value.cause;
  }
  return undefined;
}

export const confirmedSuggestionSend = (
  sql: SqlClient.SqlClient,
  thread: ThreadId | Statement.Fragment,
) =>
  sql`EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id=${thread}
    AND m.role='user' AND json_extract(m.payload_json,'$.createdBy')='user')`;

type ReservationAction =
  | { type: "create"; projectId: ProjectId }
  | { type: "send"; userAuthored: boolean; at: string };

export const checkReservedSuggestionLaunch = Effect.fn(
  "MonarchService.checkReservedSuggestionLaunch",
)(function* (sql: SqlClient.SqlClient, threadId: ThreadId, action: ReservationAction) {
  const [row] = yield* sql<{
    project_id: string;
    payload_json: string;
    thread_project: string | null;
  }>`SELECT s.project_id,s.payload_json,t.project_id thread_project FROM monarch_suggestions s
    LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=${threadId}
    WHERE json_extract(s.payload_json,'$.draftThreadId')=${threadId}
    ${action.type === "send" ? sql`AND NOT ${confirmedSuggestionSend(sql, threadId)}` : sql``} LIMIT 1`;
  if (!row) return;
  if (row.project_id !== (action.type === "create" ? action.projectId : row.thread_project))
    return yield* new ReservedSuggestionLaunchError({
      message: "Open this suggested thread in its original project before sending.",
    });
  if (action.type === "send" && !action.userAuthored)
    return yield* new ReservedSuggestionLaunchError({
      message: "Send the first message from the suggested thread's composer.",
    });
  const suggestion = yield* decodeSuggestion(row.payload_json);
  yield* validateSuggestionUse(sql, suggestion).pipe(
    Effect.catchTags({
      MonarchError: (error) =>
        Effect.fail(
          new ReservedSuggestionLaunchError({
            message:
              error.reason === "conflict"
                ? "The Target or project context changed. Review the suggestion before sending."
                : error.reason === "invalid_reference"
                  ? "A source is excluded or unavailable. Review the suggestion before sending."
                  : "This suggestion or project is no longer active. Reopen it in the project to review its status.",
          }),
        ),
    }),
  );
  // The caller commits this status together with the first user message, or rolls both back.
  if (action.type === "send")
    yield* sql`UPDATE monarch_suggestions SET revision=revision+1, payload_json=json_set(payload_json,
      '$.revision',revision+1,'$.status','used','$.usedThreadId',${threadId},'$.updatedAt',${action.at})
      WHERE id=${suggestion.id} AND project_id=${suggestion.projectId}`;
});
