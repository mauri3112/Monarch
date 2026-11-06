import { confirmedSuggestionSend } from "./SuggestionEligibility.ts";
import {
  MonarchError,
  MonarchGeneratedContextEntry,
  type MonarchJournalInput,
  type MonarchJournalRecord,
  type MonarchJournalRef,
  RunId,
  ModelSelection,
  type MonarchTimelineEvent,
  type MonarchTimelineHistoryInput,
  type ProjectId,
  type MonarchTimelineInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeModel = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeEntries = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(MonarchGeneratedContextEntry)),
);
const decodeRefs = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ runId: Schema.String, revision: Schema.Int })),
  ),
);
function modelLabel(model: ModelSelection) {
  return [model.model, model.options?.find((option) => /effort/i.test(option.id))?.value]
    .filter(Boolean)
    .join(" · ");
}
const WINDOW = 80;
const HISTORY = 160;
type Event = MonarchTimelineEvent;
type State = Event["state"];
const threadStart = (id: string) => `thread:${id}:created`;
const turnEvent = (id: string) => `turn:${id}`;
const reviewEvent = (id: string) => `review:${id}`;
const journalEvent = (id: string) => `journal:${id}`;
const planEvent = (kind: string, id: string, revision: number) =>
  `${kind}:${id}:${String(revision).padStart(10, "0")}`;
const promptEvent = (id: string, at: string) => `prompt:${id}:${at}`;
const stateOf = (status: string): State => {
  switch (status) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "completed":
    case "succeeded":
      return "finished";
    case "running":
    case "queued":
    case "starting":
    case "waiting":
    case "preparing":
      return "running";
    case "active":
    case "draft":
    case "paused":
    case "archived":
    case "achieved":
      return status;
    default:
      return "recorded";
  }
};
const descending = (a: Event, b: Event) =>
  (b.at ?? "").localeCompare(a.at ?? "") || b.id.localeCompare(a.id);

const readWindow = Effect.fn("MonarchTimeline.readWindow")(function* ({
  projectId,
  focus,
}: MonarchTimelineInput) {
  const sql = yield* SqlClient.SqlClient;
  const events: Event[] = [];

  function limited<T>(rows: ReadonlyArray<T>, limit = WINDOW) {
    return rows.slice(0, limit);
  }
  function add(
    event: Omit<Event, "parentIds" | "threadId" | "runId" | "detail" | "state"> &
      Partial<Pick<Event, "parentIds" | "threadId" | "runId" | "detail" | "state">>,
  ) {
    events.push({
      parentIds: [],
      threadId: null,
      runId: null,
      detail: "",
      state: "recorded",
      ...event,
    });
  }
  const matches = (...kinds: Event["entityKind"][]) => !focus || kinds.includes(focus.entityKind);
  if (matches("target", "suggestion")) {
    const rows = yield* sql<{
      kind: "target" | "suggestion";
      entity_id: string;
      revision: number;
      at: string;
      action: string;
      title: string;
      status: string | null;
      source_review: string | null;
      stage: string | null;
    }>`
      SELECT p.*, s.stage FROM monarch_planning_events p LEFT JOIN monarch_review_stages s
        ON s.project_id=p.project_id AND s.review_run_id=p.source_review AND s.stage='suggestions'
      WHERE p.project_id=${projectId} ${focus ? sql`AND p.kind=${focus.entityKind} AND p.entity_id=${focus.entityId}` : sql``}
      ORDER BY p.at DESC,p.revision DESC,p.kind,p.entity_id LIMIT ${WINDOW + 1}`;
    for (const p of limited(rows)) {
      const parentIds =
        p.revision === 1
          ? p.source_review
            ? [p.stage ? `stage:${p.source_review}:suggestions` : reviewEvent(p.source_review)]
            : []
          : [planEvent(p.kind, p.entity_id, 1)];
      add({
        id: planEvent(p.kind, p.entity_id, p.revision),
        family: p.kind,
        entityKind: p.kind,
        entityId: p.entity_id,
        at: p.at,
        title: p.title || p.action,
        action: p.action,
        detail: p.status ? `Revision ${p.revision} · ${p.status}` : "",
        state: stateOf(p.status ?? ""),
        parentIds,
      });
    }
  }

  if (matches("thread")) {
    const threads = yield* sql<{
      id: ThreadId;
      title: string;
      created: string;
      archived: string | null;
      settled: string | null;
      reopened: string | null;
      suggestion: string | null;
      prompt: string | null;
      started: string | null;
    }>`
      SELECT t.thread_id id,t.title,t.created_at created,t.archived_at archived,
        json_extract(t.payload_json,'$.settledAt') settled,json_extract(t.payload_json,'$.unsettledAt') reopened,
        (SELECT s.id FROM monarch_suggestions s WHERE s.project_id=t.project_id AND json_extract(s.payload_json,'$.draftThreadId')=t.thread_id AND ${confirmedSuggestionSend(sql, sql`t.thread_id`)} LIMIT 1) suggestion,
        p.task_id prompt,p.started_at started FROM orchestration_v2_projection_threads t
        LEFT JOIN monarch_prompt_runs p ON p.project_id=t.project_id AND p.thread_id=t.thread_id AND p.created_thread=1
        WHERE t.project_id=${projectId} AND t.deleted_at IS NULL ${focus ? sql`AND t.thread_id=${focus.entityId}` : sql``}
        ORDER BY t.updated_at DESC,t.thread_id DESC LIMIT ${WINDOW + 1}`;
    const visible = limited(threads);
    const titles = new Map(visible.map((t) => [t.id, t.title]));
    for (const t of visible) {
      const base = {
        family: "thread",
        entityKind: "thread",
        entityId: t.id,
        title: t.title,
        threadId: t.id,
      } as const;
      add({
        ...base,
        id: threadStart(t.id),
        action: "Thread started",
        at: t.created,
        state: "ready",
        parentIds: [
          ...(t.suggestion ? [planEvent("suggestion", t.suggestion, 1)] : []),
          ...(t.prompt && t.started ? [promptEvent(t.prompt, t.started)] : []),
        ],
      });
      for (const [at, action, state] of [
        [t.settled, "Thread settled", "finished"],
        [t.reopened, "Thread reopened", "ready"],
        [t.archived, "Thread archived", "archived"],
      ] as const) {
        if (at) add({ ...base, id: `${threadStart(t.id)}:${state}:${at}`, at, action, state });
      }
    }
    if (visible.length) {
      const ids = visible.map((t) => t.id);
      // Select each thread's latest turns through its ordinal index, including one overflow row.
      const runs = yield* sql<{
        thread_id: ThreadId;
        run_id: string;
        ordinal: number;
        status: string;
        at: string;
      }>`
        SELECT r.thread_id,r.run_id,r.ordinal,r.status,COALESCE(r.completed_at,r.requested_at) at
        FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id
        WHERE t.project_id=${projectId} AND t.thread_id IN ${sql.in(ids)} AND r.ordinal >=
          (SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest WHERE latest.thread_id=t.thread_id)-3`;
      for (const r of runs) {
        add({
          id: turnEvent(r.run_id),
          family: "thread",
          entityKind: "thread",
          entityId: r.thread_id,
          action: `Turn ${r.status.replaceAll("_", " ")}`,
          title: titles.get(r.thread_id)!,
          at: r.at,
          state: stateOf(r.status),
          threadId: r.thread_id,
          runId: r.run_id,
          parentIds: [threadStart(r.thread_id)],
        });
      }
    }
    const pending = yield* sql<{
      id: string;
      thread: ThreadId;
      title: string;
      at: string;
      kind: string;
    }>`
      SELECT q.runtime_request_id id,t.thread_id thread,t.title,q.created_at at,q.kind FROM orchestration_v2_projection_runtime_requests q
      JOIN orchestration_v2_projection_threads t ON t.thread_id=q.thread_id WHERE t.project_id=${projectId} AND t.deleted_at IS NULL
      AND q.status='pending' AND q.kind IN ('user_input','command','file-read','file-change','mcp-elicitation','permission')
      AND COALESCE(json_extract(q.payload_json,'$.responseCapability.type'),'live')!='not_resumable'
      ${focus ? sql`AND t.thread_id=${focus.entityId}` : sql``} ORDER BY q.created_at DESC,q.runtime_request_id DESC LIMIT ${WINDOW + 1}`;
    for (const q of limited(pending))
      add({
        id: `request:${q.id}`,
        family: "thread",
        entityKind: "thread",
        entityId: q.thread,
        threadId: q.thread,
        title: q.title,
        action: q.kind === "user_input" ? "Awaiting input" : "Awaiting approval",
        at: q.at,
        state: "needs-input",
        parentIds: [threadStart(q.thread)],
      });
    const waiting = new Set(pending.map((q) => q.thread));
    for (const [index, event] of events.entries())
      if (event.state === "running" && event.threadId && waiting.has(event.threadId))
        events[index] = { ...event, state: "recorded", action: "Turn awaiting response" };
  }

  if (matches("thread", "prompt-schedule")) {
    const deliveries = yield* sql<{
      message_id: string;
      thread_id: ThreadId;
      run_id: string | null;
      task: string;
      at: string;
      title: string;
    }>`
      SELECT m.message_id,m.thread_id,m.run_id,json_extract(m.payload_json,'$.scheduledTaskId') task,m.created_at at,t.title
      FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_messages m ON m.thread_id=t.thread_id
      WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND json_extract(m.payload_json,'$.scheduledTaskId') IS NOT NULL
        ${focus?.entityKind === "thread" ? sql`AND t.thread_id=${focus.entityId}` : focus ? sql`AND json_extract(m.payload_json,'$.scheduledTaskId')=${focus.entityId}` : sql``}
      ORDER BY m.created_at DESC,m.message_id DESC LIMIT ${WINDOW + 1}`;
    for (const m of limited(deliveries))
      add({
        id: `delivery:${m.message_id}`,
        family: "schedule",
        entityKind: "prompt-schedule",
        entityId: m.task,
        at: m.at,
        title: m.title,
        action: "Scheduled prompt delivered",
        threadId: m.thread_id,
        runId: m.run_id,
      });
  }
  if (matches("prompt-schedule", "review-schedule")) {
    const scheduleRows = yield* sql<{
      id: string;
      kind: "prompt-schedule" | "review-schedule";
      title: string;
      enabled: number;
      next: string | null;
      created: string;
      hook: number;
    }>`
      SELECT * FROM (
        SELECT task_id id,'prompt-schedule' kind,title,enabled,next_run_at next,created_at created,json_extract(schedule_json,'$.type')='webhook' hook
        FROM scheduled_tasks WHERE project_id=${projectId}
        UNION ALL SELECT id,'review-schedule',json_extract(payload_json,'$.title'),enabled,next_run_at,json_extract(payload_json,'$.createdAt'),0
        FROM monarch_review_schedules WHERE project_id=${projectId} AND deleted_at IS NULL AND managed=0
      ) ${focus ? sql`WHERE id=${focus.entityId} AND kind=${focus.entityKind}` : sql``}
      ORDER BY enabled DESC,next IS NULL,next,created DESC,kind,id LIMIT ${WINDOW + 1}`;
    for (const s of limited(scheduleRows)) {
      const prompt = s.kind === "prompt-schedule";
      const base = {
        family: "schedule",
        entityKind: s.kind,
        entityId: s.id,
        title: s.title,
      } as const;
      add({
        ...base,
        id: `schedule:${s.kind}:${s.id}`,
        at: s.created,
        action: prompt ? "Prompt schedule created" : "Review schedule created",
      });
      if (s.enabled && s.next)
        add({
          ...base,
          id: `next:${s.kind}:${s.id}:${s.next}`,
          action: prompt ? "Run a prompt" : "Review suggestions",
          at: s.next,
          state: "upcoming",
        });
      else if (!s.enabled || s.hook)
        add({
          ...base,
          id: `condition:${s.kind}:${s.id}`,
          at: null,
          action: s.enabled ? "On webhook delivery" : "Schedule paused",
          detail: prompt ? "Runs a prompt" : "Reviews project suggestions",
          state: s.enabled ? "conditional" : "paused",
        });
    }
  }
  if (matches("prompt-schedule")) {
    const rows = yield* sql<{
      task_id: string;
      started_at: string;
      completed_at: string | null;
      status: string;
      title: string;
      error: string | null;
      thread: ThreadId | null;
    }>`
      SELECT p.*,t.thread_id thread FROM monarch_prompt_runs p LEFT JOIN orchestration_v2_projection_threads t
        ON t.thread_id=p.thread_id AND t.project_id=p.project_id AND t.deleted_at IS NULL
      WHERE p.project_id=${projectId} ${focus ? sql`AND p.task_id=${focus.entityId}` : sql``} ORDER BY p.started_at DESC,p.task_id LIMIT ${WINDOW + 1}`;
    for (const r of limited(rows))
      add({
        id: promptEvent(r.task_id, r.started_at),
        runId: promptEvent(r.task_id, r.started_at),
        family: "schedule",
        entityKind: "prompt-schedule",
        entityId: r.task_id,
        at: r.completed_at ?? r.started_at,
        state: stateOf(r.status),
        title: r.title,
        action: `Prompt dispatch ${r.status}`,
        detail: r.error ?? (r.completed_at ? `Started ${r.started_at}` : "Recorded start time"),
        threadId: r.thread,
      });
  }
  if (matches("review", "review-schedule")) {
    const rows = yield* sql<{
      id: string;
      schedule_id: string;
      status: string;
      started_at: string;
      at: string | null;
      title: string | null;
      summary: string | null;
      error: string | null;
      n: number;
      suggestions: number | null;
      trigger: string;
      managed: number | null;
      retry: string | null;
    }>`
      SELECT r.id,r.schedule_id,r.status,r.started_at,json_extract(r.payload_json,'$.completedAt') at,
        json_extract(s.payload_json,'$.title') title,s.managed,json_extract(r.payload_json,'$.trigger') trigger,
        substr(json_extract(r.payload_json,'$.summary'),1,600) summary,substr(json_extract(r.payload_json,'$.error'),1,600) error,
        json_array_length(r.payload_json,'$.suggestionIds') n,json_extract(r.payload_json,'$.updateSuggestions') suggestions,
        json_extract(r.payload_json,'$.retryOfRunId') retry
      FROM monarch_review_runs r LEFT JOIN monarch_review_schedules s ON s.id=r.schedule_id AND s.project_id=r.project_id
      WHERE r.project_id=${projectId} ${focus?.entityKind === "review" ? sql`AND r.id=${focus.entityId}` : focus ? sql`AND r.schedule_id=${focus.entityId}` : sql``}
      ORDER BY r.started_at DESC,r.id DESC LIMIT ${WINDOW + 1}`;
    for (const r of limited(rows)) {
      const id = reviewEvent(r.id);
      const scheduled = r.managed === 0;
      const base = {
        family: scheduled ? "schedule" : "model",
        entityKind: scheduled ? "review-schedule" : "review",
        entityId: scheduled ? r.schedule_id : r.id,
        title: r.title ?? "Project update",
        runId: r.id,
      } as const;
      add({
        ...base,
        id,
        at: r.started_at,
        action: r.trigger === "retry" ? "Update retried" : "Update started",
        state: r.status === "running" ? "running" : "recorded",
        detail: `Trigger: ${r.trigger}`,
        parentIds: [
          ...(scheduled ? [`schedule:review-schedule:${r.schedule_id}`] : []),
          ...(r.retry ? [reviewEvent(r.retry)] : []),
        ],
      });
      if (r.at)
        add({
          ...base,
          id: `${id}:result`,
          at: r.at,
          state: stateOf(r.status),
          action:
            r.status === "succeeded"
              ? r.n
                ? `${r.n} ${r.n === 1 ? "thread" : "threads"} suggested`
                : r.suggestions === 0
                  ? "Context update finished"
                  : "No new suggestions"
              : `Update ${r.status}`,
          detail: r.error ?? r.summary ?? "",
          parentIds: [id],
        });
    }
  }
  if (matches("journal", "review")) {
    const journals = yield* sql<{
      run_id: string;
      thread: ThreadId;
      review: string;
      recorded: string;
      source_at: string;
      title: string;
      branch: string | null;
      n: number;
      entries: string | null;
      worktree: string | null;
      notes: string | null;
      model: string;
      revision: number;
    }>`
      SELECT j.run_id,j.thread_id thread,j.review_run_id review,j.recorded_at recorded,j.completed_at source_at,t.title,j.branch,
        json_array_length(j.entries_json) n,substr(json_extract(j.entries_json,'$[0].title'),1,200) notes,
        j.model_json model,j.worktree_path worktree,j.revision,
        CASE WHEN ${focus?.entityKind === "journal" ? sql`'journal:' || j.run_id || ':' || j.revision = ${focus.eventId ?? ""}` : sql`0`} THEN j.entries_json END entries
      FROM monarch_run_journal_revisions j JOIN orchestration_v2_projection_threads t ON j.thread_id=t.thread_id AND t.project_id=j.project_id AND t.deleted_at IS NULL
      LEFT JOIN monarch_project_context c ON c.project_id=j.project_id WHERE j.project_id=${projectId}
        AND NOT EXISTS(SELECT 1 FROM json_each(c.settings_json,'$.excludedThreadIds') x WHERE x.value=j.thread_id)
        ${
          focus?.entityKind === "journal"
            ? sql`AND j.run_id=${focus.entityId}`
            : focus
              ? sql`AND (j.review_run_id=${focus.entityId} OR EXISTS (
          SELECT 1 FROM monarch_review_stages s,json_each(s.source_refs_json) ref WHERE s.project_id=j.project_id
          AND s.review_run_id=${focus.entityId} AND json_extract(ref.value,'$.runId')=j.run_id AND json_extract(ref.value,'$.revision')=j.revision))`
              : sql``
        }
      ORDER BY ${focus?.eventId ? sql`('journal:' || j.run_id || ':' || j.revision = ${focus.eventId}) DESC,` : sql``} j.recorded_at DESC,j.run_id,j.revision DESC LIMIT ${WINDOW + 1}`;
    for (const j of limited(journals)) {
      const id = `${journalEvent(j.run_id)}:${j.revision}`;
      const model = yield* decodeModel(j.model);
      const entries = j.entries ? yield* decodeEntries(j.entries) : [];
      const header = [
        `Revision ${j.revision}`,
        modelLabel(model),
        j.branch,
        j.worktree,
        `${j.n} entries`,
      ]
        .filter(Boolean)
        .join(" · ");
      const detail = [
        header,
        ...entries.map((entry) =>
          [
            `${entry.title} (${entry.kind}, ${entry.scope}${entry.branch ? ` · ${entry.branch}` : ""}, reported)`,
            entry.body,
            ...entry.sourceRefs.map(
              (ref) => `Source: ${ref.threadId}${ref.runId ? ` · ${ref.runId}` : ""}`,
            ),
          ].join("\n"),
        ),
      ].join("\n\n");
      add({
        id,
        family: "model",
        entityKind: "journal",
        entityId: j.run_id,
        at: j.recorded,
        action: j.n ? "Journal saved" : "No journal material",
        title: j.notes || j.title,
        detail,
        threadId: j.thread,
        runId: j.run_id,
        parentIds: [turnEvent(j.run_id), `stage:${j.review}:journal`],
      });
      if (!events.some((e) => e.id === turnEvent(j.run_id)))
        add({
          id: turnEvent(j.run_id),
          family: "thread",
          entityKind: "thread",
          entityId: j.thread,
          at: j.source_at,
          action: "Turn completed",
          title: j.title,
          state: "finished",
          threadId: j.thread,
          runId: j.run_id,
          parentIds: [threadStart(j.thread)],
        });
    }
    const stages = yield* sql<{
      review: string;
      stage: string;
      at: string;
      status: string;
      model: string;
      started: string;
      refs: string;
      error: string | null;
    }>`
      SELECT s.review_run_id review,s.stage,coalesce(s.completed_at,s.started_at) at,s.status,
        s.model_json model,s.started_at started,
        (SELECT json_group_array(json_object('runId',j.run_id,'revision',j.revision)) FROM json_each(s.source_refs_json) ref
          JOIN monarch_run_journal_revisions j ON j.project_id=s.project_id AND j.run_id=json_extract(ref.value,'$.runId') AND j.revision=json_extract(ref.value,'$.revision')
          JOIN orchestration_v2_projection_threads t ON t.thread_id=j.thread_id AND t.project_id=j.project_id AND t.deleted_at IS NULL
          WHERE NOT EXISTS(SELECT 1 FROM json_each(c.settings_json,'$.excludedThreadIds') x WHERE x.value=j.thread_id)) refs,
        substr(coalesce(s.error,json_extract(r.payload_json,'$.error')),1,600) error
      FROM monarch_review_stages s LEFT JOIN monarch_review_runs r ON r.id=s.review_run_id AND r.project_id=s.project_id
      LEFT JOIN monarch_project_context c ON c.project_id=s.project_id WHERE s.project_id=${projectId}
        ${focus?.entityKind === "review" ? sql`AND s.review_run_id=${focus.entityId}` : focus ? sql`AND 0` : sql``}
      ORDER BY s.started_at DESC,s.review_run_id,s.stage LIMIT ${WINDOW + 1}`;
    for (const s of limited(stages)) {
      const refs = yield* decodeRefs(s.refs);
      const model = yield* decodeModel(s.model);
      add({
        id: `stage:${s.review}:${s.stage}`,
        family: "model",
        entityKind: "review",
        entityId: s.review,
        at: s.at,
        runId: s.review,
        state: stateOf(s.status),
        title: s.stage === "journal" ? "Write run journals" : "Review suggestions",
        action: `Model stage ${s.status}`,
        detail: [
          modelLabel(model),
          `Started ${s.started}`,
          s.stage === "suggestions" ? `${refs.length} journal revisions` : "",
          s.status === "failed" || s.status === "interrupted" ? s.error : "",
        ]
          .filter(Boolean)
          .join(" · "),
        parentIds: [
          reviewEvent(s.review),
          ...refs.map((ref) => `${journalEvent(ref.runId)}:${ref.revision}`),
        ],
      });
    }
  }
  if (!focus) {
    const [queue] = yield* sql<{
      trigger: string;
      paused: number;
      failed: string | null;
      attempted: number;
      requested: number;
      cap: number;
      used: number;
    }>`
      SELECT q.trigger,q.last_error failed,q.attempted_version attempted,q.requested_version requested,
        json_extract(c.settings_json,'$.paused') OR json_extract(c.settings_json,'$.modelSelection') IS NULL paused,
        json_extract(c.settings_json,'$.maxUpdatesPerDay') cap,
        (SELECT count(*) FROM monarch_review_runs r WHERE r.project_id=q.project_id AND r.started_at>=strftime('%Y-%m-%dT00:00:00.000Z','now')) used
      FROM monarch_continuity_queue q JOIN monarch_project_context c ON c.project_id=q.project_id
      WHERE q.project_id=${projectId} AND q.requested_version>q.completed_version
        AND NOT EXISTS(SELECT 1 FROM monarch_review_runs r WHERE r.project_id=q.project_id AND r.status='running')`;
    if (queue) {
      const reason = queue.paused
        ? "Updates are paused or need a review model."
        : queue.failed && queue.attempted >= queue.requested
          ? queue.failed
          : queue.used >= queue.cap
            ? "After the daily limit resets."
            : "When the project is idle.";
      add({
        id: `pending:${projectId}`,
        family: "model",
        entityKind: "review",
        entityId: projectId,
        at: null,
        state: "conditional",
        title: "Queued project update",
        action: "Waiting to update",
        detail: reason,
      });
    }
  }
  return { events };
});

const decodeParents = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const historyRows = Effect.fn("MonarchTimeline.historyRows")(function* (
  input: MonarchTimelineHistoryInput,
  ids?: readonly string[],
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Omit<Event, "parentIds"> & { parents: string }>`
    SELECT h.id,h.at,h.entity_kind entityKind,h.entity_id entityId,h.family,h.action,h.title,h.detail,h.state,
      h.thread_id threadId,h.run_id runId,h.parents
    FROM monarch_timeline_history h LEFT JOIN monarch_project_context c ON c.project_id=h.project_id
    WHERE h.project_id=${input.projectId}
      AND (h.thread_id IS NULL OR EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=h.thread_id AND t.project_id=h.project_id AND t.deleted_at IS NULL))
      AND (h.entity_kind!='journal' OR NOT EXISTS(SELECT 1 FROM json_each(c.settings_json,'$.excludedThreadIds') excluded WHERE excluded.value=h.thread_id))
      ${input.before ? sql`AND (h.at,h.id)<(${input.before.at},${input.before.id})` : sql``}
      ${ids ? sql`AND h.id IN ${sql.in(ids)}` : sql``}
    ORDER BY h.at DESC,h.id DESC LIMIT ${ids ? ids.length : 41}`;
  return yield* Effect.forEach(rows, ({ parents, ...row }) =>
    decodeParents(parents).pipe(Effect.map((parentIds) => ({ ...row, parentIds }))),
  );
});
const requireProject = Effect.fn("MonarchTimeline.requireProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  if (
    !(yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`)
      .length
  )
    return yield* new MonarchError({ reason: "not_found" });
});
export const readJournal = Effect.fn("MonarchService.readJournal")(function* (
  input: MonarchJournalInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<
    Omit<MonarchJournalRecord, "modelSelection" | "entries"> & { model: string; material: string }
  >`
    SELECT j.project_id projectId,j.run_id runId,j.revision,j.thread_id threadId,t.title threadTitle,
      j.review_run_id reviewRunId,j.branch,j.worktree_path worktreePath,j.completed_at completedAt,
      j.started_at startedAt,j.recorded_at recordedAt,j.model_json model,j.entries_json material
    FROM monarch_run_journal_revisions j
    JOIN projection_projects p ON p.project_id=j.project_id AND p.deleted_at IS NULL
    JOIN orchestration_v2_projection_threads t ON t.project_id=j.project_id AND t.thread_id=j.thread_id AND t.deleted_at IS NULL
    LEFT JOIN monarch_project_context c ON c.project_id=j.project_id
    WHERE j.project_id=${input.projectId} AND j.run_id=${input.runId} AND j.revision=${input.revision}
      AND NOT EXISTS(SELECT 1 FROM json_each(c.settings_json,'$.excludedThreadIds') x WHERE x.value=j.thread_id)`;
  if (!row) return { journal: null };
  const { model, material, ...metadata } = row;
  return {
    journal: {
      ...metadata,
      modelSelection: yield* decodeModel(model),
      entries: yield* decodeEntries(material),
    },
  };
});
const withJournalRefs = Effect.fn("MonarchTimeline.withJournalRefs")(function* (
  projectId: ProjectId,
  events: ReadonlyArray<Event>,
) {
  const sql = yield* SqlClient.SqlClient;
  const reviews = [
    ...new Set(
      events.flatMap((e) =>
        (e.entityKind === "review" || e.entityKind === "review-schedule") && e.runId
          ? [e.runId]
          : [],
      ),
    ),
  ];
  const refs = new Map<string, Map<string, MonarchJournalRef>>();
  if (reviews.length) {
    const rows = yield* sql<{ review: string; stage: string; runId: RunId; revision: number }>`
      WITH related(review,stage,runId,revision,thread) AS (
        SELECT s.review_run_id,s.stage,j.run_id,j.revision,j.thread_id
        FROM monarch_review_stages s CROSS JOIN json_each(s.source_run_ids_json) src
        CROSS JOIN monarch_run_journal_revisions j ON j.project_id=s.project_id AND j.run_id=src.value AND j.review_run_id=s.review_run_id
        WHERE s.project_id=${projectId} AND s.review_run_id IN ${sql.in(reviews)} AND s.stage='journal'
        UNION ALL
        SELECT s.review_run_id,s.stage,j.run_id,j.revision,j.thread_id
        FROM monarch_review_stages s CROSS JOIN json_each(s.source_refs_json) src
        CROSS JOIN monarch_run_journal_revisions j ON j.project_id=s.project_id AND j.run_id=json_extract(src.value,'$.runId')
          AND j.revision=json_extract(src.value,'$.revision')
        WHERE s.project_id=${projectId} AND s.review_run_id IN ${sql.in(reviews)} AND s.stage='suggestions'
      )
      SELECT r.review,r.stage,r.runId,r.revision FROM related r
      JOIN orchestration_v2_projection_threads t ON t.project_id=${projectId} AND t.thread_id=r.thread AND t.deleted_at IS NULL
      LEFT JOIN monarch_project_context c ON c.project_id=t.project_id
      WHERE NOT EXISTS(SELECT 1 FROM json_each(c.settings_json,'$.excludedThreadIds') x WHERE x.value=r.thread)
      ORDER BY r.review,r.stage,r.runId,r.revision`;
    for (const { review, stage, runId, revision } of rows) {
      for (const key of [reviewEvent(review), `stage:${review}:${stage}`]) {
        const group = refs.get(key) ?? new Map<string, MonarchJournalRef>();
        group.set(`${journalEvent(runId)}:${revision}`, { runId, revision });
        refs.set(key, group);
      }
    }
  }
  return events.map((event) => {
    if (event.entityKind === "journal" && event.runId) {
      const revision = Number(event.id.slice(event.id.lastIndexOf(":") + 1));
      if (
        Number.isSafeInteger(revision) &&
        revision > 0 &&
        event.id === `${journalEvent(event.runId)}:${revision}`
      )
        return { ...event, journalRefs: [{ runId: RunId.make(event.runId), revision }] };
    }
    if ((event.entityKind === "review" || event.entityKind === "review-schedule") && event.runId) {
      const key = event.id.startsWith("stage:") ? event.id : reviewEvent(event.runId);
      const modelStage = (["journal", "suggestions"] as const).find(
        (stage) => event.id === `stage:${event.runId}:${stage}`,
      );
      return {
        ...event,
        ...(modelStage ? { modelStage } : {}),
        journalRefs: [...(refs.get(key)?.values() ?? [])],
      };
    }
    return event;
  });
});

const readHistoryPage = Effect.fn("MonarchTimeline.readHistoryPage")(function* (
  input: MonarchTimelineHistoryInput,
) {
  yield* requireProject(input.projectId);
  const sql = yield* SqlClient.SqlClient;
  const [visibility] = yield* sql<{
    revision: number;
  }>`SELECT revision FROM monarch_timeline_visibility WHERE project_id=${input.projectId}`;
  const rows = yield* historyRows(input);
  const page = rows.slice(0, 40);
  const oldest = page.at(-1);
  return {
    projectId: input.projectId,
    visibilityKey: String(visibility?.revision ?? 0),
    events: page.reverse(),
    nextCursor: rows.length > 40 && oldest?.at ? { at: oldest.at, id: oldest.id } : null,
  };
});
export const readTimelineHistory = Effect.fn("MonarchService.readTimelineHistory")(function* (
  input: MonarchTimelineHistoryInput,
) {
  const page = yield* readHistoryPage(input);
  return { ...page, events: yield* withJournalRefs(input.projectId, page.events) };
});
export const readTimeline = Effect.fn("MonarchService.readTimeline")(function* (
  input: MonarchTimelineInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const page = yield* readHistoryPage({ projectId: input.projectId });
  const latest = yield* readWindow({ projectId: input.projectId });
  const liveById = new Map(latest.events.map((event) => [event.id, event]));
  const pinned = latest.events
    .filter(
      (e) =>
        e.at === null ||
        e.state === "needs-input" ||
        e.state === "running" ||
        e.state === "upcoming",
    )
    .sort(descending);
  const focus = input.focus ? yield* readWindow(input) : null;
  const chosen = [
    ...page.events.map((event) => liveById.get(event.id) ?? event),
    ...pinned.slice(0, HISTORY),
    ...(focus?.events ?? []),
  ];
  const byId = new Map(chosen.map((e) => [e.id, e]));
  const selected = input.focus;
  if (selected) {
    if (selected.eventId && !byId.has(selected.eventId)) {
      const [exact] = yield* historyRows(input, [selected.eventId]);
      if (exact?.entityKind === selected.entityKind && exact.entityId === selected.entityId)
        byId.set(exact.id, exact);
    }
    if (selected.entityKind === "suggestion") {
      const [owner] = yield* sql<{
        id: string;
      }>`SELECT json_extract(payload_json,'$.sourceRunId') id FROM monarch_suggestions
        WHERE project_id=${input.projectId} AND id=${selected.entityId}`;
      if (owner?.id) {
        const review = yield* readWindow({
          projectId: input.projectId,
          focus: { entityKind: "review", entityId: owner.id },
        });
        for (const event of review.events) byId.set(event.id, event);
      }
    }
    let path = [...byId.values()].filter(
      (e) => e.entityKind === selected.entityKind && e.entityId === selected.entityId,
    );
    for (let depth = 0; depth < 4 && path.length; depth++) {
      const ids = [...new Set(path.flatMap((e) => e.parentIds))].slice(0, 80);
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length)
        for (const row of yield* historyRows(input, missing)) byId.set(row.id, row);
      path = ids.flatMap((id) => byId.get(id) ?? []);
    }
  }
  return {
    projectId: input.projectId,
    events: yield* withJournalRefs(
      input.projectId,
      [...byId.values()].sort((a, b) => descending(b, a)),
    ),
    hasOlder: page.nextCursor !== null,
    nextCursor: page.nextCursor,
    visibilityKey: page.visibilityKey,
  };
});
