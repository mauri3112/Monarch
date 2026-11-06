import {
  MonarchCreateSuggestionInput,
  MonarchCreateTargetInput,
  MonarchError,
  MonarchProjectInput,
  MonarchSetSuggestionStatusInput,
  MonarchSuggestionInput,
  MonarchTarget,
  MonarchUpdateSuggestionInput,
  MonarchUpdateTargetInput,
  MonarchUseSuggestionInput,
  NextThreadSuggestion,
  ThreadId,
  type MonarchJournalInput,
  MonarchJournalResult,
  type MonarchTimelineInput,
  type MonarchTimelineHistoryInput,
  type MonarchTimelineHistoryResult,
  MonarchTimelineResult,
  type MonarchProjectState,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  confirmedSuggestionSend,
  validateSuggestionReferences,
  validateSuggestionUse,
} from "./SuggestionEligibility.ts";
import { readJournal, readTimeline, readTimelineHistory } from "./MonarchTimeline.ts";

export class MonarchService extends Context.Service<
  MonarchService,
  {
    readonly journal: (
      input: MonarchJournalInput,
    ) => Effect.Effect<MonarchJournalResult, MonarchError>;
    readonly watchJournal: (
      input: MonarchJournalInput,
    ) => Stream.Stream<MonarchJournalResult, MonarchError>;
    readonly timelineHistory: (
      input: MonarchTimelineHistoryInput,
    ) => Effect.Effect<MonarchTimelineHistoryResult, MonarchError>;
    readonly timeline: (
      input: MonarchTimelineInput,
    ) => Effect.Effect<MonarchTimelineResult, MonarchError>;
    readonly watchTimeline: (
      input: MonarchTimelineInput,
    ) => Stream.Stream<MonarchTimelineResult, MonarchError>;
    readonly list: (input: MonarchProjectInput) => Effect.Effect<MonarchProjectState, MonarchError>;
    readonly watch: (
      input: MonarchProjectInput,
    ) => Stream.Stream<MonarchProjectState, MonarchError>;
    readonly createTarget: (
      input: MonarchCreateTargetInput,
    ) => Effect.Effect<MonarchTarget, MonarchError>;
    readonly updateTarget: (
      input: MonarchUpdateTargetInput,
    ) => Effect.Effect<MonarchTarget, MonarchError>;
    readonly createSuggestion: (
      input: MonarchCreateSuggestionInput,
    ) => Effect.Effect<NextThreadSuggestion, MonarchError>;
    readonly updateSuggestion: (
      input: MonarchUpdateSuggestionInput,
    ) => Effect.Effect<NextThreadSuggestion, MonarchError>;
    readonly setSuggestionStatus: (
      input: MonarchSetSuggestionStatusInput,
    ) => Effect.Effect<NextThreadSuggestion, MonarchError>;
    readonly prepareSuggestion: (
      input: MonarchSuggestionInput,
    ) => Effect.Effect<NextThreadSuggestion, MonarchError>;
    readonly markSuggestionUsed: (
      input: MonarchUseSuggestionInput,
    ) => Effect.Effect<NextThreadSuggestion, MonarchError>;
  }
>()("t3/monarch/MonarchService") {}

const MAX_ACTIVE_SUGGESTIONS = 200;
const SUGGESTION_HISTORY_LIMIT = 100;

const now = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);
const isMonarchError = Schema.is(MonarchError);
const sameJournal = Schema.toEquivalence(MonarchJournalResult);
const sameTimeline = Schema.toEquivalence(MonarchTimelineResult);
const decodeTarget = Schema.decodeEffect(Schema.fromJsonString(MonarchTarget));
const encodeTarget = Schema.encodeEffect(Schema.fromJsonString(MonarchTarget));
const decodeSuggestion = Schema.decodeEffect(Schema.fromJsonString(NextThreadSuggestion));
const encodeSuggestion = Schema.encodeEffect(Schema.fromJsonString(NextThreadSuggestion));

const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isMonarchError(cause) ? cause : new MonarchError({ reason: "storage", cause }),
    ),
  );
const decodeInput = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new MonarchError({ reason: "invalid_input", cause })),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  // A change is only a wake-up signal: every subscriber reloads its own project.
  const changes = yield* PubSub.sliding<void>(1);
  const changed = sql.afterCommit(PubSub.publish(changes, undefined).pipe(Effect.asVoid));
  const projectExists = Effect.fn("MonarchService.projectExists")(function* (projectId: ProjectId) {
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`.pipe(
        storage,
      );
    if (rows.length === 0) return yield* new MonarchError({ reason: "not_found" });
  });
  const requireSentThread = Effect.fn("MonarchService.requireSentThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const rows =
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND project_id = ${projectId} AND deleted_at IS NULL AND ${confirmedSuggestionSend(sql, threadId)}`.pipe(
        storage,
      );
    if (rows.length === 0) return yield* new MonarchError({ reason: "invalid_reference" });
  });
  const readTarget = Effect.fn("MonarchService.readTarget")(function* (
    projectId: ProjectId,
    id: string,
  ) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM monarch_targets WHERE project_id = ${projectId} AND id = ${id}`.pipe(
      storage,
    );
    if (!rows[0]) return yield* new MonarchError({ reason: "not_found" });
    return yield* decodeTarget(rows[0].payload).pipe(storage);
  });
  // A thread commit may succeed even when the browser loses its acknowledgement.
  // Recover its link from the reserved identity before reads and later mutations.
  const reconcileUsage = Effect.fn("MonarchService.reconcileUsage")(function* (
    projectId: ProjectId,
  ) {
    const timestamp = yield* now;
    yield* sql`UPDATE monarch_suggestions SET revision = revision + 1,
      payload_json = json_set(payload_json, '$.status', 'used', '$.usedThreadId', json_extract(payload_json, '$.draftThreadId'),
        '$.revision', revision + 1, '$.updatedAt', ${timestamp})
      WHERE project_id = ${projectId} AND json_extract(payload_json, '$.status') != 'used'
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads thread
        WHERE thread.thread_id = json_extract(monarch_suggestions.payload_json, '$.draftThreadId')
        AND thread.project_id = monarch_suggestions.project_id AND thread.deleted_at IS NULL AND ${confirmedSuggestionSend(sql, sql`thread.thread_id`)})`.pipe(
      storage,
    );
  });
  const requireSuggestionCapacity = Effect.fn("MonarchService.requireSuggestionCapacity")(
    function* (projectId: ProjectId) {
      yield* reconcileUsage(projectId);
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM monarch_suggestions
      WHERE project_id = ${projectId} AND json_extract(payload_json, '$.status') = 'suggested'`.pipe(
        storage,
      );
      if ((row?.count ?? 0) >= MAX_ACTIVE_SUGGESTIONS)
        return yield* new MonarchError({ reason: "capacity" });
    },
  );
  const readSuggestion = Effect.fn("MonarchService.readSuggestion")(function* (
    projectId: ProjectId,
    id: string,
  ) {
    yield* reconcileUsage(projectId);
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM monarch_suggestions WHERE project_id = ${projectId} AND id = ${id}`.pipe(
      storage,
    );
    if (!rows[0]) return yield* new MonarchError({ reason: "not_found" });
    return yield* decodeSuggestion(rows[0].payload).pipe(storage);
  });
  const saveSuggestion = Effect.fn("MonarchService.saveSuggestion")(function* (
    value: NextThreadSuggestion,
    expectedRevision: number,
  ) {
    const json = yield* encodeSuggestion(value).pipe(storage);
    const rows =
      yield* sql`UPDATE monarch_suggestions SET revision = ${value.revision}, payload_json = ${json}
      WHERE id = ${value.id} AND project_id = ${value.projectId} AND revision = ${expectedRevision} RETURNING id`.pipe(
        storage,
      );
    if (rows.length !== 1) return yield* new MonarchError({ reason: "conflict" });
    return value;
  });
  const requireSuggestion = Effect.fn("MonarchService.requireSuggestion")(function* (
    input: MonarchSuggestionInput,
  ) {
    yield* projectExists(input.projectId);
    const value = yield* readSuggestion(input.projectId, input.id);
    if (value.revision !== input.expectedRevision)
      return yield* new MonarchError({ reason: "conflict" });
    if (value.status === "used") return yield* new MonarchError({ reason: "invalid_state" });
    return value;
  });
  const list: MonarchService["Service"]["list"] = Effect.fn("MonarchService.list")(
    function* (input) {
      yield* projectExists(input.projectId);
      yield* reconcileUsage(input.projectId);
      const targetRows = yield* sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM monarch_targets WHERE project_id = ${input.projectId} ORDER BY id`.pipe(
        storage,
      );
      // Active items are never displaced by history. Creation and restore enforce the active bound.
      const activeRows = yield* sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM monarch_suggestions
        WHERE project_id = ${input.projectId} AND json_extract(payload_json, '$.status') = 'suggested'
        ORDER BY json_extract(payload_json, '$.updatedAt') DESC, id DESC`.pipe(storage);
      const historyRows = yield* sql<{
        id: string;
        payload: string;
      }>`SELECT id,payload_json AS payload FROM monarch_suggestions
        WHERE project_id = ${input.projectId} AND json_extract(payload_json, '$.status') != 'suggested'
        ORDER BY json_extract(payload_json, '$.updatedAt') DESC, id DESC LIMIT ${SUGGESTION_HISTORY_LIMIT + (input.focusSuggestionId ? 2 : 1)}`.pipe(
        storage,
      );
      const suggestionRows = [...activeRows, ...historyRows.slice(0, SUGGESTION_HISTORY_LIMIT)];
      const targets = yield* Effect.forEach(targetRows, (row) =>
        decodeTarget(row.payload).pipe(storage),
      );
      const suggestions = yield* Effect.forEach(suggestionRows, (row) =>
        decodeSuggestion(row.payload).pipe(storage),
      );
      const focusId = input.focusSuggestionId;
      if (
        focusId &&
        historyRows.length > SUGGESTION_HISTORY_LIMIT &&
        !suggestions.some((s) => s.id === focusId)
      ) {
        const [focused] = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM monarch_suggestions
          WHERE project_id=${input.projectId} AND id=${focusId}`.pipe(storage);
        if (focused) suggestions.push(yield* decodeSuggestion(focused.payload).pipe(storage));
      }
      return {
        targets,
        suggestions,
        hasMoreHistory: historyRows
          .slice(SUGGESTION_HISTORY_LIMIT)
          .some((row) => row.id !== focusId),
      };
    },
    sql.withTransaction,
    storage,
  );
  const createTarget: MonarchService["Service"]["createTarget"] = Effect.fn(
    "MonarchService.createTarget",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchCreateTargetInput, raw);
      yield* projectExists(input.projectId);
      const timestamp = yield* now;
      const target: MonarchTarget = {
        ...input,
        id: yield* random.uuidV4(),
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const json = yield* encodeTarget(target).pipe(storage);
      yield* sql`INSERT INTO monarch_targets (id, project_id, revision, payload_json) VALUES (${target.id}, ${target.projectId}, ${target.revision}, ${json})`.pipe(
        storage,
      );
      return target;
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const updateTarget: MonarchService["Service"]["updateTarget"] = Effect.fn(
    "MonarchService.updateTarget",
  )(
    function* (raw) {
      const { expectedRevision, ...input } = yield* decodeInput(MonarchUpdateTargetInput, raw);
      yield* projectExists(input.projectId);
      const previous = yield* readTarget(input.projectId, input.id);
      if (previous.revision !== expectedRevision)
        return yield* new MonarchError({ reason: "conflict" });
      const target: MonarchTarget = {
        ...previous,
        ...input,
        revision: previous.revision + 1,
        updatedAt: yield* now,
      };
      const json = yield* encodeTarget(target).pipe(storage);
      const rows =
        yield* sql`UPDATE monarch_targets SET revision = ${target.revision}, payload_json = ${json}
      WHERE project_id = ${target.projectId} AND id = ${target.id} AND revision = ${expectedRevision} RETURNING id`.pipe(
          storage,
        );
      if (rows.length !== 1) return yield* new MonarchError({ reason: "conflict" });
      return target;
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const createSuggestion: MonarchService["Service"]["createSuggestion"] = Effect.fn(
    "MonarchService.createSuggestion",
  )(
    function* (raw) {
      const { dedupeKey, ...input } = yield* decodeInput(MonarchCreateSuggestionInput, raw);
      yield* projectExists(input.projectId);
      if (dedupeKey !== undefined) {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM monarch_suggestions WHERE project_id = ${input.projectId} AND dedupe_key = ${dedupeKey}`.pipe(
          storage,
        );
        if (rows[0]) return yield* readSuggestion(input.projectId, rows[0].id);
      }
      yield* requireSuggestionCapacity(input.projectId);
      yield* validateSuggestionReferences(sql, input);
      const timestamp = yield* now;
      const value: NextThreadSuggestion = {
        ...input,
        id: yield* random.uuidV4(),
        status: "suggested",
        revision: 1,
        usedThreadId: null,
        draftThreadId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const json = yield* encodeSuggestion(value).pipe(storage);
      const inserted =
        yield* sql`INSERT INTO monarch_suggestions (id, project_id, revision, dedupe_key, payload_json)
      VALUES (${value.id}, ${value.projectId}, ${value.revision}, ${dedupeKey ?? null}, ${json})
      ON CONFLICT(project_id, dedupe_key) DO NOTHING RETURNING id`.pipe(storage);
      if (inserted.length === 0 && dedupeKey !== undefined) {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM monarch_suggestions WHERE project_id = ${input.projectId} AND dedupe_key = ${dedupeKey}`.pipe(
          storage,
        );
        if (rows[0]) return yield* readSuggestion(input.projectId, rows[0].id);
        return yield* new MonarchError({ reason: "storage" });
      }
      return value;
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const updateSuggestion: MonarchService["Service"]["updateSuggestion"] = Effect.fn(
    "MonarchService.updateSuggestion",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchUpdateSuggestionInput, raw);
      const previous = yield* requireSuggestion(input);
      const targets = input.targets ?? previous.targets;
      const contextRevision = input.contextRevision ?? previous.contextRevision;
      if (input.targets !== undefined || input.contextRevision !== undefined)
        yield* validateSuggestionReferences(sql, {
          ...previous,
          targets,
          ...(contextRevision === undefined ? {} : { contextRevision }),
        });
      return yield* saveSuggestion(
        {
          ...previous,
          targets,
          ...(contextRevision === undefined ? {} : { contextRevision }),
          title: input.title,
          prompt: input.prompt,
          revision: previous.revision + 1,
          updatedAt: yield* now,
        },
        input.expectedRevision,
      );
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const setSuggestionStatus: MonarchService["Service"]["setSuggestionStatus"] = Effect.fn(
    "MonarchService.setSuggestionStatus",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchSetSuggestionStatusInput, raw);
      const previous = yield* requireSuggestion(input);
      if (input.status === "suggested" && previous.status !== "suggested")
        yield* requireSuggestionCapacity(input.projectId);
      return yield* saveSuggestion(
        {
          ...previous,
          status: input.status,
          revision: previous.revision + 1,
          updatedAt: yield* now,
        },
        input.expectedRevision,
      );
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const prepareSuggestion: MonarchService["Service"]["prepareSuggestion"] = Effect.fn(
    "MonarchService.prepareSuggestion",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchSuggestionInput, raw);
      const previous = yield* requireSuggestion(input);
      yield* validateSuggestionUse(sql, previous);
      if (previous.draftThreadId !== null) return previous;
      return yield* saveSuggestion(
        {
          ...previous,
          draftThreadId: ThreadId.make(yield* random.uuidV4()),
          revision: previous.revision + 1,
          updatedAt: yield* now,
        },
        input.expectedRevision,
      );
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const markSuggestionUsed: MonarchService["Service"]["markSuggestionUsed"] = Effect.fn(
    "MonarchService.markSuggestionUsed",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchUseSuggestionInput, raw);
      yield* projectExists(input.projectId);
      const previous = yield* readSuggestion(input.projectId, input.id);
      // A retried acknowledgement must not create a second thread or lose its first link.
      if (previous.status === "used" && previous.usedThreadId === input.threadId) {
        yield* requireSentThread(input.projectId, input.threadId);
        return previous;
      }
      if (previous.revision !== input.expectedRevision)
        return yield* new MonarchError({ reason: "conflict" });
      if (previous.status !== "suggested" || previous.draftThreadId !== input.threadId)
        return yield* new MonarchError({ reason: "invalid_state" });
      yield* requireSentThread(input.projectId, input.threadId);
      return yield* saveSuggestion(
        {
          ...previous,
          status: "used",
          usedThreadId: input.threadId,
          revision: previous.revision + 1,
          updatedAt: yield* now,
        },
        input.expectedRevision,
      );
    },
    sql.withTransaction,
    storage,
    Effect.tap(() => changed),
  );
  const timeline = (input: MonarchTimelineInput) =>
    readTimeline(input).pipe(
      sql.withTransaction,
      SqliteClient.readOnly,
      Effect.provideService(SqlClient.SqlClient, sql),
      storage,
    );
  // data_version sees other connections; total_changes also covers the single-connection in-memory database.
  const timelineVersion = sql<{
    version: string;
  }>`SELECT data_version || ':' || total_changes() || ':' || date('now') AS version FROM pragma_data_version`.pipe(
    sql.withTransaction,
    SqliteClient.readOnly,
    storage,
    Effect.map((rows) => rows[0]!.version),
  );
  const journal = (input: MonarchJournalInput) =>
    readJournal(input).pipe(
      sql.withTransaction,
      SqliteClient.readOnly,
      Effect.provideService(SqlClient.SqlClient, sql),
      storage,
    );
  const timelineHistory = (input: MonarchTimelineHistoryInput) =>
    readTimelineHistory(input).pipe(
      sql.withTransaction,
      SqliteClient.readOnly,
      Effect.provideService(SqlClient.SqlClient, sql),
      storage,
    );
  return MonarchService.of({
    timeline,
    timelineHistory,
    journal,
    watchJournal: (input) =>
      Stream.tick("3 seconds").pipe(
        Stream.mapEffect(() => timelineVersion),
        Stream.changes,
        Stream.mapEffect(() => journal(input)),
        Stream.changesWith(sameJournal),
      ),
    watchTimeline: (input) =>
      Stream.tick("3 seconds").pipe(
        Stream.mapEffect(() => timelineVersion),
        Stream.changes,
        Stream.mapEffect(() => timeline(input)),
        Stream.changesWith(sameTimeline),
      ),
    list,
    createTarget,
    updateTarget,
    createSuggestion,
    updateSuggestion,
    setSuggestionStatus,
    prepareSuggestion,
    markSuggestionUsed,
    watch: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      ),
  });
});
export const layer = Layer.effect(MonarchService, make);
