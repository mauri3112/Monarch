import {
  MonarchContextApplyGeneratedInput,
  MonarchContextBriefInput,
  MonarchContextEntry,
  MonarchContextEntryInput,
  MonarchContextError,
  MonarchContextHistoryInput,
  MonarchContextProjectInput,
  MonarchContextRestoreEntryInput,
  MonarchContextSettings,
  MonarchContextSourceScopeInput,
  type MonarchContextSourceScope,
  MonarchContextUpdateSettingsInput,
  MonarchContextUpsertEntryInput,
  type MonarchContextBrief,
  type MonarchContextHistory,
  type MonarchContextState,
  type MonarchGeneratedContextEntry,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

export class MonarchContextService extends Context.Service<
  MonarchContextService,
  {
    readonly get: (
      input: MonarchContextProjectInput,
    ) => Effect.Effect<MonarchContextState, MonarchContextError>;
    readonly watch: (
      input: MonarchContextProjectInput,
    ) => Stream.Stream<MonarchContextState, MonarchContextError>;
    readonly updateSettings: (
      input: MonarchContextUpdateSettingsInput,
    ) => Effect.Effect<MonarchContextState, MonarchContextError>;
    readonly upsertEntry: (
      input: MonarchContextUpsertEntryInput,
    ) => Effect.Effect<MonarchContextEntry, MonarchContextError>;
    readonly removeEntry: (
      input: MonarchContextEntryInput,
    ) => Effect.Effect<MonarchContextEntry, MonarchContextError>;
    readonly restoreEntry: (
      input: MonarchContextRestoreEntryInput,
    ) => Effect.Effect<MonarchContextEntry, MonarchContextError>;
    readonly history: (
      input: MonarchContextHistoryInput,
    ) => Effect.Effect<MonarchContextHistory, MonarchContextError>;
    readonly applyGenerated: (
      input: MonarchContextApplyGeneratedInput,
    ) => Effect.Effect<MonarchContextState, MonarchContextError>;
    readonly sourceScope: (
      input: MonarchContextSourceScopeInput,
    ) => Effect.Effect<MonarchContextSourceScope, MonarchContextError>;
    readonly brief: (
      input: MonarchContextBriefInput,
    ) => Effect.Effect<MonarchContextBrief, MonarchContextError>;
  }
>()("t3/monarch/MonarchContextService") {}

const DEFAULT_SETTINGS: MonarchContextSettings = {
  enabled: false,
  autoUpdateContext: true,
  suggestAfterWork: true,
  suggestAfterTargetChange: true,
  paused: false,
  modelSelection: null,
  maxUpdatesPerDay: 6,
  maxOpenSuggestions: 10,
  excludedThreadIds: [],
  instructions: "",
  brief: "",
};
const MAX_ENTRIES = 200;
const HISTORY_PAGE_SIZE = 100;
const BRIEF_LIMIT = 12_000;
const isContextError = Schema.is(MonarchContextError);
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(MonarchContextSettings));
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(MonarchContextSettings));
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(MonarchContextEntry));
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(MonarchContextEntry));
const encodeTargetFingerprint = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Int }))),
);
const materialKey = (entry: MonarchGeneratedContextEntry) =>
  `${entry.kind}|${entry.scope}|${entry.branch ?? ""}|${entry.title.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ")}|${entry.body.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ")}`;
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isContextError(cause) ? cause : new MonarchContextError({ reason: "storage", cause }),
    ),
  );
const decodeInput = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new MonarchContextError({ reason: "invalid_input", cause })),
  );
type StateRow = {
  revision: number;
  settings_revision: number;
  settings_json: string;
  enabled_at: string | null;
  updated_at: string | null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.sliding<void>(1);
  const notify = sql.afterCommit(PubSub.publish(changes, undefined).pipe(Effect.asVoid));

  const requireProject = Effect.fn("MonarchContextService.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`.pipe(
        storage,
      );
    if (rows.length === 0) return yield* new MonarchContextError({ reason: "not_found" });
  });
  const settingsFor = Effect.fn("MonarchContextService.settingsFor")(function* (
    projectId: ProjectId,
  ) {
    yield* requireProject(projectId);
    const [row] =
      yield* sql<StateRow>`SELECT revision, settings_revision, settings_json, enabled_at, updated_at
      FROM monarch_project_context WHERE project_id = ${projectId}`.pipe(storage);
    if (!row)
      return {
        revision: 0,
        settingsRevision: 0,
        settings: DEFAULT_SETTINGS,
        enabledAt: null,
        updatedAt: null,
      };
    return {
      revision: row.revision,
      settingsRevision: row.settings_revision,
      settings: yield* decodeSettings(row.settings_json).pipe(storage),
      enabledAt: row.enabled_at,
      updatedAt: row.updated_at,
    };
  });
  const initialize = Effect.fn("MonarchContextService.initialize")(function* (
    projectId: ProjectId,
  ) {
    yield* requireProject(projectId);
    yield* sql`INSERT INTO monarch_project_context(project_id, settings_json) VALUES (${projectId}, ${yield* encodeSettings(DEFAULT_SETTINGS).pipe(storage)})
      ON CONFLICT(project_id) DO NOTHING`.pipe(storage);
  });
  const bumpRevision = Effect.fn("MonarchContextService.bumpRevision")(function* (
    projectId: ProjectId,
  ) {
    yield* initialize(projectId);
    const [row] = yield* sql<{
      revision: number;
    }>`UPDATE monarch_project_context SET revision = revision + 1, updated_at = ${yield* now}
      WHERE project_id = ${projectId} RETURNING revision`.pipe(storage);
    if (!row) return yield* new MonarchContextError({ reason: "not_found" });
    return row.revision;
  });
  const readEntry = Effect.fn("MonarchContextService.readEntry")(function* (
    projectId: ProjectId,
    entryId: string,
  ) {
    const [row] = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM monarch_context_entries WHERE project_id = ${projectId} AND id = ${entryId}`.pipe(
      storage,
    );
    if (!row) return yield* new MonarchContextError({ reason: "not_found" });
    return yield* decodeEntry(row.payload).pipe(storage);
  });
  const requireCapacity = Effect.fn("MonarchContextService.requireCapacity")(function* (
    projectId: ProjectId,
    added: number,
  ) {
    const [row] = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM monarch_context_entries WHERE project_id = ${projectId} AND removed_at IS NULL`.pipe(
      storage,
    );
    if ((row?.count ?? 0) + added > MAX_ENTRIES)
      return yield* new MonarchContextError({ reason: "capacity" });
  });
  const sourceThread = Effect.fn("MonarchContextService.sourceThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const [row] = yield* sql<{
      branch: string | null;
    }>`SELECT json_extract(payload_json, '$.branch') AS branch FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId} AND thread_id = ${threadId} AND deleted_at IS NULL`.pipe(
      storage,
    );
    if (!row) return yield* new MonarchContextError({ reason: "invalid_reference" });
    return row;
  });
  const sourceScope: MonarchContextService["Service"]["sourceScope"] = Effect.fn(
    "MonarchContextService.sourceScope",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextSourceScopeInput, raw);
      yield* requireProject(input.projectId);
      yield* sourceThread(input.projectId, input.threadId);
      const [run] = yield* sql<{
        branch: string | null;
        worktreePath: string | null;
        workspaceType: string | null;
      }>`SELECT
      json_extract(payload_json, '$.workspacePreparation.type') AS workspaceType,
      json_extract(payload_json, '$.workspacePreparation.branch') AS branch,
      json_extract(payload_json, '$.workspacePreparation.worktreePath') AS worktreePath
      FROM orchestration_v2_projection_runs WHERE run_id = ${input.runId} AND thread_id = ${input.threadId} AND status = 'completed'`.pipe(
        storage,
      );
      if (!run) return yield* new MonarchContextError({ reason: "invalid_reference" });
      if (run.branch !== null) return { branch: run.branch, worktreePath: run.worktreePath };
      if (
        run.workspaceType === "worktree" ||
        (run.workspaceType === "existing_worktree" && run.worktreePath === null)
      )
        return yield* new MonarchContextError({ reason: "unknown_scope" });
      const [snapshot] = yield* sql<{ branch: string | null; worktreePath: string | null }>`SELECT
      json_extract(payload_json, '$.branch') AS branch, json_extract(payload_json, '$.worktreePath') AS worktreePath
      FROM orchestration_events WHERE stream_id = ${input.threadId} AND application_event_version = 2
      AND json_type(payload_json, '$.branch') IS NOT NULL AND json_type(payload_json, '$.worktreePath') IS NOT NULL
      AND event_type LIKE 'thread.%' AND sequence <= (
        SELECT MIN(sequence) FROM orchestration_events WHERE stream_id = ${input.threadId}
          AND application_event_version = 2 AND event_type = 'run.created' AND json_extract(payload_json, '$.id') = ${input.runId}
      ) ORDER BY sequence DESC LIMIT 1`.pipe(storage);
      if (
        !snapshot ||
        (snapshot.branch === null && snapshot.worktreePath !== null) ||
        (run.worktreePath !== null &&
          (snapshot.worktreePath !== run.worktreePath || snapshot.branch === null))
      )
        return yield* new MonarchContextError({ reason: "unknown_scope" });
      return snapshot;
    },
    sql.withTransaction,
    storage,
  );
  const validateEntry = Effect.fn("MonarchContextService.validateEntry")(function* (
    projectId: ProjectId,
    entry: MonarchGeneratedContextEntry,
    excludedThreadIds: ReadonlyArray<ThreadId>,
    generated: boolean,
  ) {
    if (
      (entry.scope === "branch") !== (entry.branch !== null) ||
      (generated &&
        (entry.sourceRefs.length === 0 || entry.sourceRefs.some((source) => source.runId === null)))
    )
      return yield* new MonarchContextError({ reason: "invalid_input" });
    for (const source of entry.sourceRefs) {
      if (excludedThreadIds.includes(source.threadId))
        return yield* new MonarchContextError({ reason: "excluded_source" });
      yield* sourceThread(projectId, source.threadId);
      if (source.runId !== null) {
        const rows = yield* sql`SELECT run_id FROM orchestration_v2_projection_runs
          WHERE run_id = ${source.runId} AND thread_id = ${source.threadId}
          ${generated ? sql`AND status = 'completed'` : sql``}`.pipe(storage);
        if (rows.length === 0)
          return yield* new MonarchContextError({ reason: "invalid_reference" });
      }
      if (generated && source.runId !== null) {
        const scope = yield* sourceScope({
          projectId,
          threadId: source.threadId,
          runId: source.runId,
        });
        if (scope.branch !== null && (entry.scope !== "branch" || entry.branch !== scope.branch))
          return yield* new MonarchContextError({ reason: "invalid_reference" });
        if (scope.branch === null && entry.scope !== "project")
          return yield* new MonarchContextError({ reason: "invalid_reference" });
      }
    }
    for (const id of entry.contradictsEntryIds) {
      const referenced = yield* readEntry(projectId, id).pipe(
        Effect.catchTags({
          MonarchContextError: (error) =>
            Effect.fail(
              error.reason === "not_found"
                ? new MonarchContextError({ reason: "invalid_reference" })
                : error,
            ),
        }),
      );
      if (
        referenced.removedAt !== null ||
        referenced.sourceRefs.some((ref) => excludedThreadIds.includes(ref.threadId))
      )
        return yield* new MonarchContextError({ reason: "invalid_reference" });
    }
  });
  const saveEntry = Effect.fn("MonarchContextService.saveEntry")(function* (
    entry: MonarchContextEntry,
    action: "created" | "updated" | "removed" | "restored",
  ) {
    const json = yield* encodeEntry(entry).pipe(storage);
    yield* sql`INSERT INTO monarch_context_entries(id, project_id, revision, removed_at, payload_json)
      VALUES (${entry.id}, ${entry.projectId}, ${entry.revision}, ${entry.removedAt}, ${json})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, removed_at = excluded.removed_at, payload_json = excluded.payload_json`.pipe(
      storage,
    );
    yield* sql`INSERT INTO monarch_context_history(project_id, entry_id, revision, action, payload_json)
      VALUES (${entry.projectId}, ${entry.id}, ${entry.revision}, ${action}, ${json})`.pipe(
      storage,
    );
    yield* sql`INSERT INTO monarch_context_material_keys(project_id, material_key) VALUES (${entry.projectId}, ${materialKey(entry)})
      ON CONFLICT(project_id, material_key) DO NOTHING`.pipe(storage);
    yield* notify;
    return entry;
  });
  const get: MonarchContextService["Service"]["get"] = Effect.fn("MonarchContextService.get")(
    function* (input) {
      const state = yield* settingsFor(input.projectId);
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM monarch_context_entries
      WHERE project_id = ${input.projectId} AND removed_at IS NULL
      ORDER BY json_extract(payload_json, '$.pinned') DESC, json_extract(payload_json, '$.updatedAt') DESC, id LIMIT ${MAX_ENTRIES}`.pipe(
        storage,
      );
      const decoded = yield* Effect.forEach(rows, (row) => decodeEntry(row.payload).pipe(storage));
      const hidden = new Set(
        decoded
          .filter((entry) =>
            entry.sourceRefs.some((source) =>
              state.settings.excludedThreadIds.includes(source.threadId),
            ),
          )
          .map((entry) => entry.id),
      );
      const dependents = new Map<string, string[]>();
      for (const entry of decoded) {
        if (entry.origin !== "agent") continue;
        for (const sourceId of entry.contradictsEntryIds) {
          const ids = dependents.get(sourceId) ?? [];
          ids.push(entry.id);
          dependents.set(sourceId, ids);
        }
      }
      // Generated contradictions can quote earlier context; propagate exclusions without hiding explicit user edits.
      const pending = [...hidden];
      while (pending.length > 0) {
        const sourceId = pending.pop()!;
        for (const id of dependents.get(sourceId) ?? []) {
          if (hidden.has(id)) continue;
          hidden.add(id);
          pending.push(id);
        }
      }
      const entries = decoded.filter((entry) => !hidden.has(entry.id));
      return { projectId: input.projectId, ...state, entries };
    },
    sql.withTransaction,
    storage,
  );
  const updateSettings: MonarchContextService["Service"]["updateSettings"] = Effect.fn(
    "MonarchContextService.updateSettings",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextUpdateSettingsInput, raw);
      if (input.settings.enabled && input.settings.modelSelection === null)
        return yield* new MonarchContextError({ reason: "invalid_input" });
      const state = yield* settingsFor(input.projectId);
      if (state.settingsRevision !== input.expectedRevision)
        return yield* new MonarchContextError({ reason: "conflict" });
      for (const id of input.settings.excludedThreadIds) yield* sourceThread(input.projectId, id);
      yield* initialize(input.projectId);
      const enabledAt = !input.settings.enabled
        ? null
        : state.settings.enabled
          ? state.enabledAt
          : yield* now;
      const [sequence] = yield* sql<{
        sequence: number;
      }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`.pipe(storage);
      const targetRows = yield* sql<{
        id: string;
        revision: number;
      }>`SELECT id, revision FROM monarch_targets
        WHERE project_id = ${input.projectId} AND json_extract(payload_json, '$.status') = 'active' ORDER BY id`.pipe(
        storage,
      );
      const targetFingerprint = yield* encodeTargetFingerprint(targetRows).pipe(storage);
      yield* sql`UPDATE monarch_project_context SET settings_json = ${yield* encodeSettings(input.settings).pipe(storage)},
      settings_revision = settings_revision + 1, revision = revision + 1, updated_at = ${yield* now}, enabled_at = ${enabledAt},
      enabled_sequence = CASE WHEN ${input.settings.enabled ? 1 : 0} = 0 THEN NULL WHEN ${state.settings.enabled ? 1 : 0} = 0 THEN ${sequence?.sequence ?? 0} ELSE enabled_sequence END,
      enabled_target_fingerprint = CASE WHEN ${input.settings.enabled ? 1 : 0} = 0 THEN NULL WHEN ${state.settings.enabled ? 1 : 0} = 0 THEN ${targetFingerprint} ELSE enabled_target_fingerprint END
      WHERE project_id = ${input.projectId}`.pipe(storage);
      yield* notify;
      return yield* get({ projectId: input.projectId });
    },
    sql.withTransaction,
    storage,
  );
  const upsertEntry: MonarchContextService["Service"]["upsertEntry"] = Effect.fn(
    "MonarchContextService.upsertEntry",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextUpsertEntryInput, raw);
      const state = yield* settingsFor(input.projectId);
      const previous = input.id === undefined ? null : yield* readEntry(input.projectId, input.id);
      if (
        (previous && previous.revision !== input.expectedRevision) ||
        (!previous && input.expectedRevision !== undefined)
      )
        return yield* new MonarchContextError({ reason: "conflict" });
      if (previous?.removedAt != null)
        return yield* new MonarchContextError({ reason: "not_found" });
      yield* validateEntry(input.projectId, input, state.settings.excludedThreadIds, false);
      if (!previous) yield* requireCapacity(input.projectId, 1);
      const timestamp = yield* now;
      const { expectedRevision: _expected, id: _id, ...fields } = input;
      return yield* saveEntry(
        {
          ...fields,
          id: previous?.id ?? (yield* random.uuidV4()),
          origin: "user",
          generationId: previous?.generationId ?? null,
          revision: (previous?.revision ?? 0) + 1,
          contextRevision: yield* bumpRevision(input.projectId),
          removedAt: null,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        },
        previous ? "updated" : "created",
      );
    },
    sql.withTransaction,
    storage,
  );
  const removeEntry: MonarchContextService["Service"]["removeEntry"] = Effect.fn(
    "MonarchContextService.removeEntry",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextEntryInput, raw);
      yield* requireProject(input.projectId);
      const previous = yield* readEntry(input.projectId, input.entryId);
      if (previous.revision !== input.expectedRevision)
        return yield* new MonarchContextError({ reason: "conflict" });
      if (previous.removedAt !== null) return previous;
      const timestamp = yield* now;
      return yield* saveEntry(
        {
          ...previous,
          revision: previous.revision + 1,
          contextRevision: yield* bumpRevision(input.projectId),
          removedAt: timestamp,
          updatedAt: timestamp,
        },
        "removed",
      );
    },
    sql.withTransaction,
    storage,
  );
  const restoreEntry: MonarchContextService["Service"]["restoreEntry"] = Effect.fn(
    "MonarchContextService.restoreEntry",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextRestoreEntryInput, raw);
      const state = yield* settingsFor(input.projectId);
      const previous = yield* readEntry(input.projectId, input.entryId);
      if (previous.revision !== input.expectedRevision)
        return yield* new MonarchContextError({ reason: "conflict" });
      let selected = previous;
      if (input.restoreRevision !== undefined) {
        const [row] = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM monarch_context_history
        WHERE project_id = ${input.projectId} AND entry_id = ${input.entryId} AND revision = ${input.restoreRevision}`.pipe(
          storage,
        );
        if (!row) return yield* new MonarchContextError({ reason: "not_found" });
        selected = yield* decodeEntry(row.payload).pipe(storage);
      }
      yield* validateEntry(input.projectId, selected, state.settings.excludedThreadIds, false);
      if (previous.removedAt !== null) yield* requireCapacity(input.projectId, 1);
      return yield* saveEntry(
        {
          ...selected,
          revision: previous.revision + 1,
          contextRevision: yield* bumpRevision(input.projectId),
          removedAt: null,
          updatedAt: yield* now,
        },
        "restored",
      );
    },
    sql.withTransaction,
    storage,
  );
  const history: MonarchContextService["Service"]["history"] = Effect.fn(
    "MonarchContextService.history",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextHistoryInput, raw);
      yield* requireProject(input.projectId);
      if (input.entryId !== undefined) yield* readEntry(input.projectId, input.entryId);
      const rows = yield* sql<{
        sequence: number;
        action: "created" | "updated" | "removed" | "restored";
        payload: string;
      }>`
      SELECT sequence, action, payload_json AS payload FROM monarch_context_history WHERE project_id = ${input.projectId}
      ${input.entryId === undefined ? sql`` : sql`AND entry_id = ${input.entryId}`}
      ${input.beforeSequence === undefined ? sql`` : sql`AND sequence < ${input.beforeSequence}`}
      ORDER BY sequence DESC LIMIT ${HISTORY_PAGE_SIZE + 1}`.pipe(storage);
      const items = yield* Effect.forEach(rows.slice(0, HISTORY_PAGE_SIZE), (row) =>
        decodeEntry(row.payload).pipe(
          storage,
          Effect.map((entry) => ({ sequence: row.sequence, action: row.action, entry })),
        ),
      );
      return {
        items,
        nextBeforeSequence: rows.length > HISTORY_PAGE_SIZE ? items.at(-1)!.sequence : null,
      };
    },
    sql.withTransaction,
    storage,
  );
  const applyGenerated: MonarchContextService["Service"]["applyGenerated"] = Effect.fn(
    "MonarchContextService.applyGenerated",
  )(
    function* (raw) {
      const input = yield* decodeInput(MonarchContextApplyGeneratedInput, raw);
      const state = yield* settingsFor(input.projectId);
      const receipt =
        yield* sql`SELECT generation_id FROM monarch_context_generations WHERE project_id = ${input.projectId} AND generation_id = ${input.generationId}`.pipe(
          storage,
        );
      if (receipt.length > 0) return yield* get({ projectId: input.projectId });
      if (state.revision !== input.expectedRevision)
        return yield* new MonarchContextError({ reason: "conflict" });
      for (const entry of input.entries)
        yield* validateEntry(input.projectId, entry, state.settings.excludedThreadIds, true);
      // Remember material from every revision, including removed or corrected claims.
      const entries: MonarchGeneratedContextEntry[] = [];
      const batchKeys = new Set<string>();
      for (const entry of input.entries) {
        const key = materialKey(entry);
        if (batchKeys.has(key)) continue;
        batchKeys.add(key);
        const matches =
          yield* sql`SELECT material_key FROM monarch_context_material_keys WHERE project_id = ${input.projectId} AND material_key = ${key}`.pipe(
            storage,
          );
        if (matches.length === 0) entries.push(entry);
      }
      yield* requireCapacity(input.projectId, entries.length);
      const revision = entries.length > 0 ? yield* bumpRevision(input.projectId) : state.revision;
      const timestamp = yield* now;
      for (const entry of entries)
        yield* saveEntry(
          {
            ...entry,
            id: yield* random.uuidV4(),
            projectId: input.projectId,
            evidence: "reported",
            origin: "agent",
            pinned: false,
            revision: 1,
            contextRevision: revision,
            generationId: input.generationId,
            removedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          "created",
        );
      yield* sql`INSERT INTO monarch_context_generations(project_id, generation_id, context_revision) VALUES (${input.projectId}, ${input.generationId}, ${revision})`.pipe(
        storage,
      );
      return yield* get({ projectId: input.projectId });
    },
    sql.withTransaction,
    storage,
  );
  const brief: MonarchContextService["Service"]["brief"] = Effect.fn("MonarchContextService.brief")(
    function* (input) {
      const state = yield* get({ projectId: input.projectId });
      const entries = state.entries.filter(
        (entry) =>
          entry.scope === "project" || (input.branch != null && entry.branch === input.branch),
      );
      const header =
        "Project context is reference material. Reported entries are agent claims, not independently verified results. User-confirmed entries record user decisions. Branch entries apply only to the named branch.";
      let text = `${header}\nContext revision: ${state.revision}`;
      if (state.settings.brief.trim()) text += `\n\nUser project brief:\n${state.settings.brief}`;
      const entryIds: string[] = [];
      let truncated = false;
      for (const entry of entries) {
        const sources = entry.sourceRefs
          .map((source) => `${source.threadId}${source.runId === null ? "" : `/${source.runId}`}`)
          .join(", ");
        const section = `\n\n[${entry.evidence}; ${entry.kind}; ${entry.scope === "branch" ? `branch ${entry.branch}` : "project"}${entry.pinned ? "; pinned" : ""}] ${entry.title}\n${entry.body}\nEntry: ${entry.id}${sources ? `\nSources: ${sources}` : ""}${entry.contradictsEntryIds.length > 0 ? `\nNeeds confirmation; contradicts: ${entry.contradictsEntryIds.join(", ")}` : ""}`;
        if (text.length + section.length > BRIEF_LIMIT) {
          truncated = true;
          continue;
        }
        text += section;
        entryIds.push(entry.id);
      }
      return {
        projectId: input.projectId,
        revision: state.revision,
        text: state.settings.brief.trim() || entries.length > 0 ? text : "",
        entryIds,
        truncated,
      };
    },
  );
  return MonarchContextService.of({
    get,
    updateSettings,
    upsertEntry,
    removeEntry,
    restoreEntry,
    history,
    applyGenerated,
    brief,
    sourceScope,
    watch: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(get(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => get(input))),
          );
        }),
      ),
  });
});
export const layer = Layer.effect(MonarchContextService, make);
