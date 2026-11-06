import {
  MonarchGeneratedContextEntry,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  MonarchReviewSchedule,
  MonarchScheduleError,
  MonarchScheduleRun,
  MonarchSchedulesUpsertInput,
  MONARCH_REVIEW_DRIVER_KINDS,
  ThreadId,
  RunId,
  MonarchProjectRefreshInput,
  type MonarchProjectActivityResult,
  type MonarchProjectSourcesResult,
  type MonarchContextState,
  type ModelSelection,
  type MonarchScheduleIdentity,
  type MonarchScheduleRecurrence,
  type MonarchSchedulesRemoveInput,
  type MonarchSchedulesSetEnabledInput,
  type ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION } from "@t3tools/shared/monarchContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MonarchService from "./MonarchService.ts";
import * as MonarchContextService from "./MonarchContextService.ts";
import { encodeReviewContext } from "./ReviewContextBudget.ts";

/** Fixed local times follow DST. Missing local times shift forward; repeated times run once. */
export function nextMonarchReviewAt(
  recurrence: MonarchScheduleRecurrence,
  timezone: string,
  from: string,
): string {
  const now = DateTime.makeUnsafe(from);
  if (recurrence.type === "interval") {
    return DateTime.formatIso(DateTime.addDuration(now, recurrence.everyMinutes * 60_000));
  }
  const zoned = DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(timezone));
  const [hour, minute] = recurrence.timeOfDay.split(":").map(Number);
  for (let day = 0; day <= 7; day++) {
    const candidate = DateTime.setParts(DateTime.add(zoned, { days: day }), {
      hour: hour!,
      minute: minute!,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(now)) continue;
    if (recurrence.type === "weekly" && DateTime.toParts(candidate).weekDay !== recurrence.weekday)
      continue;
    return DateTime.formatIso(candidate);
  }
  throw new Error("Validated recurrence has no next occurrence");
}

export class MonarchScheduler extends Context.Service<
  MonarchScheduler,
  {
    readonly list: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      { readonly schedules: ReadonlyArray<MonarchReviewSchedule> },
      MonarchScheduleError
    >;
    readonly watch: (input: {
      readonly projectId: ProjectId;
    }) => Stream.Stream<
      { readonly schedules: ReadonlyArray<MonarchReviewSchedule> },
      MonarchScheduleError
    >;
    readonly upsert: (
      input: MonarchSchedulesUpsertInput,
    ) => Effect.Effect<MonarchReviewSchedule, MonarchScheduleError>;
    readonly setEnabled: (
      input: typeof MonarchSchedulesSetEnabledInput.Type,
    ) => Effect.Effect<MonarchReviewSchedule, MonarchScheduleError>;
    readonly remove: (
      input: typeof MonarchSchedulesRemoveInput.Type,
    ) => Effect.Effect<void, MonarchScheduleError>;
    readonly runNow: (
      input: MonarchScheduleIdentity,
    ) => Effect.Effect<{ readonly runId: string }, MonarchScheduleError>;
    readonly history: (
      input: MonarchScheduleIdentity,
    ) => Effect.Effect<{ readonly runs: ReadonlyArray<MonarchScheduleRun> }, MonarchScheduleError>;
    readonly refresh: (
      input: MonarchProjectRefreshInput,
    ) => Effect.Effect<{ readonly jobId: string; readonly status: "queued" }, MonarchScheduleError>;
    readonly activity: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<MonarchProjectActivityResult, MonarchScheduleError>;
    readonly watchActivity: (input: {
      readonly projectId: ProjectId;
    }) => Stream.Stream<MonarchProjectActivityResult, MonarchScheduleError>;
    readonly sources: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<MonarchProjectSourcesResult, MonarchScheduleError>;
  }
>()("t3/monarch/MonarchScheduler") {}

type PayloadRow = { readonly payload_json: string };
type ScheduleRow = PayloadRow & {
  readonly active_run_id: string | null;
  readonly deleted_at: string | null;
  readonly managed: number;
};
type ContinuityQueue = {
  project_id: ProjectId;
  schedule_id: string;
  cursor_sequence: number;
  target_fingerprint: string;
  requested_version: number;
  attempted_version: number;
  completed_version: number;
  trigger: MonarchScheduleRun["trigger"];
  update_context: number;
  update_suggestions: number;
  last_error: string | null;
  enabled_sequence: number | null;
};
const decodeSchedule = Schema.decodeEffect(Schema.fromJsonString(MonarchReviewSchedule));
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(MonarchReviewSchedule));
const decodeRun = Schema.decodeEffect(Schema.fromJsonString(MonarchScheduleRun));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(MonarchScheduleRun));
const journalEntries = Schema.Array(MonarchGeneratedContextEntry).check(Schema.isMaxLength(5));
const decodeJournalEntries = Schema.decodeEffect(Schema.fromJsonString(journalEntries));
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUpsert = Schema.decodeEffect(MonarchSchedulesUpsertInput);
const decodeRefresh = Schema.decodeEffect(MonarchProjectRefreshInput);
const isScheduleError = Schema.is(MonarchScheduleError);
const storageError = (cause: unknown) =>
  isScheduleError(cause) ? cause : new MonarchScheduleError({ reason: "persistence", cause });
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
// A lease outlives the bounded provider call. Expired work is recorded, never replayed.
const RUN_LEASE_MS = 9 * 60_000;
const RUN_TIMEOUT_MS = 8 * 60_000;
const MAX_SCHEDULES_PER_PROJECT = 50;
const REVIEW_DRIVERS = new Set<string>(MONARCH_REVIEW_DRIVER_KINDS);
const normalizeSuggestionText = (text: string) =>
  text.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  const monarch = yield* MonarchService.MonarchService;
  const context = yield* MonarchContextService.MonarchContextService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const project = Effect.fn("MonarchScheduler.project")(function* (projectId: ProjectId) {
    const [row] = yield* sql<{ workspace_root: string; title: string; archived_at: string | null }>`
      SELECT workspace_root, title, archived_at FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL`;
    if (!row) return yield* new MonarchScheduleError({ reason: "not_found" });
    return row;
  }, Effect.mapError(storageError));

  const selectedProvider = Effect.fn("MonarchScheduler.selectedProvider")(function* (
    selection: ModelSelection,
    projectId: ProjectId,
    journal = false,
  ) {
    const configuration = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new MonarchScheduleError({ reason: "provider_unavailable", cause }),
      ),
    );
    if (!resolveProjectProviderInstanceEnabled(configuration, projectId, selection.instanceId))
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    const instance = yield* registry.getInstance(selection.instanceId);
    if (
      !instance ||
      !(journal
        ? instance.textGeneration.generateProjectContext
        : instance.textGeneration.generateProjectSuggestions)
    ) {
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    const model = snapshot.models.find(
      (candidate) =>
        candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
    );
    const unsupportedOption =
      journal &&
      selection.options?.some((option) => {
        const descriptor = model?.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
        return descriptor?.type === "select"
          ? !descriptor.options.some((choice) => choice.id === option.value)
          : descriptor?.type !== "boolean" || typeof option.value !== "boolean";
      });
    if (
      !REVIEW_DRIVERS.has(snapshot.driver) ||
      !snapshot.enabled ||
      !snapshot.installed ||
      snapshot.auth.status === "unauthenticated" ||
      !isProviderAvailable(snapshot) ||
      !model ||
      unsupportedOption
    ) {
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    }
    return instance.textGeneration;
  });

  const read = Effect.fn("MonarchScheduler.read")(function* (
    input: MonarchScheduleIdentity,
    includeRemoved = false,
  ) {
    const [row] =
      yield* sql<ScheduleRow>`SELECT payload_json, active_run_id, deleted_at, managed FROM monarch_review_schedules
      WHERE id = ${input.id} AND project_id = ${input.projectId}`;
    if (!row || (!includeRemoved && row.deleted_at !== null))
      return yield* new MonarchScheduleError({ reason: "not_found" });
    return {
      schedule: yield* decodeSchedule(row.payload_json),
      activeRunId: row.active_run_id,
      managed: row.managed === 1,
    };
  }, Effect.mapError(storageError));

  const save = Effect.fn("MonarchScheduler.save")(function* (schedule: MonarchReviewSchedule) {
    yield* sql`UPDATE monarch_review_schedules SET enabled = ${schedule.enabled ? 1 : 0},
      next_run_at = ${schedule.nextRunAt}, payload_json = ${yield* encodeSchedule(schedule)} WHERE id = ${schedule.id}`;
  }, Effect.mapError(storageError));

  const list = Effect.fn("MonarchScheduler.list")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    yield* project(input.projectId);
    const rows = yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_schedules
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL AND managed = 0 ORDER BY id LIMIT ${MAX_SCHEDULES_PER_PROJECT}`;
    return { schedules: yield* Effect.forEach(rows, (row) => decodeSchedule(row.payload_json)) };
  }, Effect.mapError(storageError));

  const upsert = Effect.fn("MonarchScheduler.upsert")(function* (raw: MonarchSchedulesUpsertInput) {
    const input = yield* decodeUpsert(raw).pipe(
      Effect.mapError((cause) => new MonarchScheduleError({ reason: "invalid", cause })),
    );
    const currentProject = yield* project(input.projectId);
    if (input.enabled) {
      if (currentProject.archived_at !== null)
        return yield* new MonarchScheduleError({ reason: "not_found" });
      yield* selectedProvider(input.modelSelection, input.projectId);
    }
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = input.id
          ? (yield* read({ projectId: input.projectId, id: input.id })).schedule
          : null;
        if (existing && existing.revision !== input.expectedRevision)
          return yield* new MonarchScheduleError({ reason: "conflict" });
        if (!existing) {
          const [count] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM monarch_review_schedules WHERE project_id = ${input.projectId} AND deleted_at IS NULL AND managed = 0`;
          if ((count?.count ?? 0) >= MAX_SCHEDULES_PER_PROJECT)
            return yield* new MonarchScheduleError({ reason: "invalid" });
        }
        const now = yield* nowIso;
        const changedTime =
          !existing ||
          existing.enabled !== input.enabled ||
          existing.timezone !== input.timezone ||
          (yield* encodeContext(existing.recurrence)) !== (yield* encodeContext(input.recurrence));
        const schedule: MonarchReviewSchedule = {
          id: existing?.id ?? `review:${yield* random.uuidV4()}`,
          projectId: input.projectId,
          kind: "review-project",
          title: input.title,
          instructions: input.instructions,
          recurrence: input.recurrence,
          timezone: input.timezone,
          modelSelection: input.modelSelection,
          enabled: input.enabled,
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          nextRunAt: !input.enabled
            ? null
            : changedTime
              ? nextMonarchReviewAt(input.recurrence, input.timezone, now)
              : existing.nextRunAt,
          lastRunAt: existing?.lastRunAt ?? null,
          lastRunStatus: existing?.lastRunStatus ?? "idle",
          lastRunError: existing?.lastRunError ?? null,
          runCount: existing?.runCount ?? 0,
        };
        if (existing) yield* save(schedule);
        else
          yield* sql`INSERT INTO monarch_review_schedules (id, project_id, enabled, next_run_at, payload_json)
        VALUES (${schedule.id}, ${schedule.projectId}, ${schedule.enabled ? 1 : 0}, ${schedule.nextRunAt}, ${yield* encodeSchedule(schedule)})`;
        return schedule;
      }),
    );
    yield* notify;
    return result;
  }, Effect.mapError(storageError));

  const setEnabled = Effect.fn("MonarchScheduler.setEnabled")(function* (
    input: typeof MonarchSchedulesSetEnabledInput.Type,
  ) {
    const { schedule } = yield* read(input);
    return yield* upsert({
      ...schedule,
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
    });
  });

  const remove = Effect.fn("MonarchScheduler.remove")(function* (
    input: typeof MonarchSchedulesRemoveInput.Type,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* project(input.projectId);
        const { schedule, activeRunId } = yield* read(input);
        if (schedule.revision !== input.expectedRevision)
          return yield* new MonarchScheduleError({ reason: "conflict" });
        if (activeRunId !== null) return yield* new MonarchScheduleError({ reason: "busy" });
        // Keep run provenance reachable after removing a schedule from the active list.
        yield* save({ ...schedule, enabled: false, nextRunAt: null });
        yield* sql`UPDATE monarch_review_schedules SET deleted_at = ${yield* nowIso} WHERE id = ${input.id} AND project_id = ${input.projectId}`;
      }),
    );
    yield* notify;
  }, Effect.mapError(storageError));

  const history = Effect.fn("MonarchScheduler.history")(function* (input: MonarchScheduleIdentity) {
    yield* project(input.projectId);
    yield* read(input, true);
    const rows = yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs
      WHERE schedule_id = ${input.id} AND project_id = ${input.projectId} ORDER BY started_at DESC, id DESC LIMIT 100`;
    return { runs: yield* Effect.forEach(rows, (row) => decodeRun(row.payload_json)) };
  }, Effect.mapError(storageError));

  const activeWork = Effect.fn("MonarchScheduler.activeWork")(function* (
    projectId: ProjectId,
    excluded: ReadonlyArray<ThreadId> = [],
  ) {
    return yield* sql<{ threadId: string; title: string; status: string }>`
      SELECT DISTINCT t.thread_id AS threadId, substr(t.title,1,200) AS title, r.status
      FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id
      WHERE t.project_id=${projectId} AND t.deleted_at IS NULL
        AND ${excluded.length ? sql`t.thread_id NOT IN ${sql.in(excluded)}` : sql`1`}
        AND r.status IN ('queued','preparing','starting','running','waiting') LIMIT 50`;
  }, Effect.mapError(storageError));

  const dailyUsage = Effect.fn("MonarchScheduler.dailyUsage")(function* (projectId: ProjectId) {
    const day = (yield* nowIso).slice(0, 10) + "T00:00:00.000Z";
    const [row] = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM monarch_review_runs WHERE project_id=${projectId} AND started_at>=${day}`;
    return row?.count ?? 0;
  }, Effect.mapError(storageError));

  const completedSources = Effect.fn("MonarchScheduler.completedSources")(function* (
    projectId: ProjectId,
    excluded: ReadonlyArray<ThreadId>,
    runIds?: ReadonlyArray<RunId>,
    limit = 20,
  ) {
    if (runIds?.length === 0) return [];
    const rows = yield* sql<{
      threadId: ThreadId;
      title: string;
      runId: RunId;
      completedAt: string;
    }>`
      SELECT t.thread_id AS threadId, substr(t.title,1,200) AS title, r.run_id AS runId, r.completed_at AS completedAt
      FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id
      WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND r.status='completed' AND r.completed_at IS NOT NULL
        AND ${excluded.length ? sql`t.thread_id NOT IN ${sql.in(excluded)}` : sql`1`}
        AND ${runIds ? sql`r.run_id IN ${sql.in(runIds)}` : sql`r.ordinal=(SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest WHERE latest.thread_id=t.thread_id AND latest.status='completed')`}
      ORDER BY r.completed_at DESC, r.run_id DESC LIMIT ${limit}`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const sourceScope = yield* context
          .sourceScope({ projectId, threadId: row.threadId, runId: row.runId })
          .pipe(
            Effect.catchTags({
              MonarchContextError: (error) =>
                error.reason === "unknown_scope" ? Effect.succeed(null) : Effect.fail(error),
            }),
          );
        return {
          ...row,
          branch: sourceScope?.branch ?? null,
          worktreePath: sourceScope?.worktreePath ?? null,
          scopeKnown: sourceScope !== null,
          evidence: "reported" as const,
        };
      }),
    );
  }, Effect.mapError(storageError));

  const sources = Effect.fn("MonarchScheduler.sources")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    yield* project(input.projectId);
    const state = yield* context.get(input);
    const candidates = yield* completedSources(input.projectId, [], undefined, 50);
    return {
      sources: candidates
        .filter((source) => source.scopeKnown)
        .map(({ threadId, title, runId, completedAt }) => ({
          threadId,
          title,
          runId,
          completedAt,
          excluded: state.settings.excludedThreadIds.includes(threadId),
        })),
    };
  }, Effect.mapError(storageError));

  const targetFingerprint = Effect.fn("MonarchScheduler.targetFingerprint")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{
      id: string;
      revision: number;
    }>`SELECT id,revision FROM monarch_targets WHERE project_id=${projectId}
      AND json_extract(payload_json,'$.status')='active' ORDER BY id`;
    return yield* encodeContext(rows);
  }, Effect.mapError(storageError));

  const ensureQueue = Effect.fn("MonarchScheduler.ensureQueue")(function* (
    state: MonarchContextState,
    fallbackModel?: ModelSelection,
  ) {
    const selection = state.settings.modelSelection ?? fallbackModel;
    if (!selection) return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [existing] =
          yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${state.projectId}`;
        const [activation] = yield* sql<{
          enabled_sequence: number | null;
          enabled_target_fingerprint: string | null;
        }>`SELECT enabled_sequence,enabled_target_fingerprint FROM monarch_project_context WHERE project_id=${state.projectId}`;
        if (existing) {
          const { schedule } = yield* read({
            projectId: state.projectId,
            id: existing.schedule_id,
          });
          if (
            schedule.instructions !== state.settings.instructions ||
            (yield* encodeContext(schedule.modelSelection)) !== (yield* encodeContext(selection))
          )
            yield* save({
              ...schedule,
              modelSelection: selection,
              instructions: state.settings.instructions,
            });
          if (
            activation?.enabled_sequence !== null &&
            activation?.enabled_sequence !== undefined &&
            activation.enabled_sequence !== existing.enabled_sequence
          ) {
            yield* sql`UPDATE monarch_continuity_queue SET cursor_sequence=${activation.enabled_sequence},enabled_sequence=${activation.enabled_sequence},
            target_fingerprint=${activation.enabled_target_fingerprint ?? (yield* targetFingerprint(state.projectId))} WHERE project_id=${state.projectId}`;
            return {
              ...existing,
              cursor_sequence: activation.enabled_sequence,
              enabled_sequence: activation.enabled_sequence,
              target_fingerprint:
                activation.enabled_target_fingerprint ??
                (yield* targetFingerprint(state.projectId)),
            };
          }
          return existing;
        }
        const now = yield* nowIso;
        const id = `continuity:${yield* random.uuidV4()}`;
        const managed: MonarchReviewSchedule = {
          id,
          projectId: state.projectId,
          kind: "review-project",
          title: "Project context and suggestions",
          instructions: state.settings.instructions,
          recurrence: { type: "interval", everyMinutes: 60 },
          timezone: "UTC",
          modelSelection: selection,
          enabled: false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "idle",
          lastRunError: null,
          runCount: 0,
        };
        yield* sql`INSERT INTO monarch_review_schedules(id,project_id,enabled,payload_json,managed) VALUES(${id},${state.projectId},0,${yield* encodeSchedule(managed)},1)`;
        const [latest] = yield* sql<{
          sequence: number | null;
        }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
        const cursor = activation?.enabled_sequence ?? latest?.sequence ?? 0;
        const fingerprint =
          activation?.enabled_target_fingerprint ?? (yield* targetFingerprint(state.projectId));
        yield* sql`INSERT INTO monarch_continuity_queue(project_id,schedule_id,cursor_sequence,target_fingerprint,enabled_sequence,update_context,update_suggestions)
        VALUES(${state.projectId},${id},${cursor},${fingerprint},${activation?.enabled_sequence ?? null},0,0)`;
        const [created] =
          yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${state.projectId}`;
        return created!;
      }),
    );
  }, Effect.mapError(storageError));

  const enqueueSources = Effect.fn("MonarchScheduler.enqueueSources")(function* (
    projectId: ProjectId,
    sourceRows: ReadonlyArray<{ threadId: ThreadId; runId: RunId; sequence?: number }>,
  ) {
    let count = 0;
    for (const source of sourceRows) {
      const inserted =
        yield* sql`INSERT INTO monarch_continuity_sources(project_id,run_id,thread_id,event_sequence)
        VALUES(${projectId},${source.runId},${source.threadId},${source.sequence ?? 0}) ON CONFLICT(project_id,run_id) DO NOTHING RETURNING run_id`;
      count += inserted.length;
    }
    return count;
  }, Effect.mapError(storageError));

  const discover = Effect.fn("MonarchScheduler.discover")(function* () {
    const projects = yield* sql<{
      project_id: ProjectId;
    }>`SELECT c.project_id FROM monarch_project_context c JOIN projection_projects p ON p.project_id=c.project_id
      WHERE json_extract(c.settings_json,'$.enabled')=1 AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY c.project_id`;
    for (const row of projects) {
      const state = yield* context.get({ projectId: row.project_id });
      if (!state.settings.modelSelection) continue;
      const queue = yield* ensureQueue(state);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [fresh] =
            yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${state.projectId}`;
          const current = fresh ?? queue;
          const events = yield* sql<{
            sequence: number;
            threadId: ThreadId;
            runId: RunId;
          }>`SELECT e.sequence,e.stream_id AS threadId,json_extract(e.payload_json,'$.id') AS runId
          FROM orchestration_events e JOIN orchestration_v2_projection_threads t ON t.thread_id=e.stream_id
          WHERE e.sequence>${current.cursor_sequence} AND e.event_type='run.updated' AND json_extract(e.payload_json,'$.status')='completed'
            AND t.project_id=${state.projectId} AND t.deleted_at IS NULL ORDER BY e.sequence LIMIT 100`;
          const eligible = events.filter(
            (event) => !state.settings.excludedThreadIds.includes(event.threadId),
          );
          const count = yield* enqueueSources(state.projectId, eligible);
          const fingerprint = yield* targetFingerprint(state.projectId);
          const targetChanged = fingerprint !== current.target_fingerprint;
          const workChanged =
            count > 0 && (state.settings.autoUpdateContext || state.settings.suggestAfterWork);
          const targetTrigger = targetChanged && state.settings.suggestAfterTargetChange;
          if (events.length > 0 || targetChanged)
            yield* sql`UPDATE monarch_continuity_queue SET cursor_sequence=${events.at(-1)?.sequence ?? current.cursor_sequence},target_fingerprint=${fingerprint}
          WHERE project_id=${state.projectId}`;
          if (workChanged || targetTrigger) {
            const priorPending = current.requested_version > current.attempted_version;
            const workCause =
              workChanged ||
              (priorPending && ((current.update_context | current.update_suggestions) & 2) !== 0);
            const targetCause =
              targetTrigger || (priorPending && (current.update_suggestions & 4) !== 0);
            const trigger =
              priorPending && ((current.update_context | current.update_suggestions) & 1) !== 0
                ? current.trigger
                : workCause && targetCause
                  ? "project-changed"
                  : workCause
                    ? "work-completed"
                    : "targets-changed";
            yield* sql`UPDATE monarch_continuity_queue SET requested_version=requested_version+1,
            trigger=${trigger},last_error=NULL,
            update_context=update_context | ${state.settings.autoUpdateContext && workChanged ? 2 : 0},
            update_suggestions=update_suggestions | ${(workChanged && state.settings.suggestAfterWork ? 2 : 0) | (targetTrigger ? 4 : 0)} WHERE project_id=${state.projectId}`;
            yield* sql.afterCommit(notify);
          } else if (count > 0) {
            yield* sql`UPDATE monarch_continuity_sources SET captured=1 WHERE project_id=${state.projectId} AND run_id IN ${sql.in(eligible.map((e) => e.runId))}`;
          }
        }),
      );
    }
  }, Effect.mapError(storageError));

  const startStage = Effect.fn("MonarchScheduler.startStage")(function* (
    run: MonarchScheduleRun,
    stage: "journal" | "suggestions",
    selection: ModelSelection,
    sources: ReadonlyArray<RunId>,
  ) {
    yield* sql`INSERT INTO monarch_review_stages(project_id,review_run_id,stage,source_run_ids_json,model_json,started_at,status)
      VALUES(${run.projectId},${run.id},${stage},${yield* encodeContext(sources)},${yield* encodeContext(selection)},${yield* nowIso},'running')`;
    yield* notify;
  }, Effect.mapError(storageError));

  const requireClaim = Effect.fn("MonarchScheduler.requireClaim")(function* (
    run: MonarchScheduleRun,
  ) {
    const [row] = yield* sql`SELECT s.id FROM monarch_review_schedules s
      JOIN projection_projects p ON p.project_id=s.project_id
      WHERE s.id=${run.scheduleId} AND s.project_id=${run.projectId} AND s.active_run_id=${run.id}
        AND p.deleted_at IS NULL AND p.archived_at IS NULL`;
    if (!row) return yield* new MonarchScheduleError({ reason: "conflict" });
  }, Effect.mapError(storageError));

  const captureContext = Effect.fn("MonarchScheduler.captureContext")(
    function* (schedule: MonarchReviewSchedule, run: MonarchScheduleRun) {
      const projectId = schedule.projectId;
      const state = yield* context.get({ projectId });
      if (
        state.settings.paused ||
        (run.contextRevision !== undefined && run.contextRevision !== state.revision)
      )
        return yield* new MonarchScheduleError({ reason: "conflict" });
      if (!run.updateContext || !run.sourceRunIds?.length)
        return { state, entryIds: [] as string[], summary: "No new outcomes to capture." };
      const candidates = yield* completedSources(
        projectId,
        state.settings.excludedThreadIds,
        run.sourceRunIds,
      );
      const evidence = candidates.filter((source) => source.scopeKnown);
      const skipped = run.sourceRunIds.length - evidence.length;
      const summary = skipped
        ? `Skipped ${skipped} unavailable outcomes or outcomes whose original workspace scope could not be established.`
        : "Project outcomes reviewed.";
      const selection =
        state.settings.journalModelSelection ?? DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION;
      const targetsAtCapture = yield* targetFingerprint(projectId);
      const entries: MonarchGeneratedContextEntry[] = [];
      for (const source of evidence) {
        const [saved] = yield* sql<{
          entries_json: string;
          revision: number;
        }>`SELECT entries_json,revision FROM monarch_run_journals WHERE project_id=${projectId} AND run_id=${source.runId}`;
        const revision = run.journalRevision ?? 1;
        if (saved && saved.revision >= revision) {
          entries.push(...(yield* decodeJournalEntries(saved.entries_json)));
          continue;
        }
        yield* startStage(run, "journal", selection, [source.runId]);
        const startedAt = yield* nowIso;
        const provider = yield* selectedProvider(selection, projectId, true);
        const messages = yield* sql<{
          role: string;
          text: string;
        }>`SELECT role, substr(json_extract(payload_json,'$.text'),1,3000) AS text
        FROM orchestration_v2_projection_messages WHERE thread_id=${source.threadId} AND run_id=${source.runId}
          AND role IN ('user','assistant') AND streaming=0 ORDER BY created_at DESC,message_id DESC LIMIT 2`;
        const currentEntries = state.entries
          .filter(
            (entry) =>
              (entry.scope === "project" || entry.branch === source.branch) &&
              (entry.pinned ||
                entry.origin === "user" ||
                !entry.sourceRefs.some((ref) => ref.runId === source.runId)),
          )
          .toSorted(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              Number(b.evidence === "confirmed") - Number(a.evidence === "confirmed") ||
              b.updatedAt.localeCompare(a.updatedAt),
          )
          .slice(0, 30)
          .map(({ id, kind, title, body, scope, branch, evidence, pinned, origin }) => ({
            id,
            kind,
            title,
            body,
            scope,
            branch,
            evidence,
            pinned,
            origin,
          }));
        const result = yield* provider.generateProjectContext!({
          cwd: (yield* project(projectId)).workspace_root,
          modelSelection: selection,
          context: yield* encodeReviewContext({
            instructions: state.settings.instructions,
            currentEntries,
            candidateCompletedRuns: [{ ...source, messages: messages.toReversed() }],
          }),
        });
        const material = yield* Schema.decodeEffect(journalEntries)(result.entries);
        if (
          material.some(
            (entry) =>
              entry.sourceRefs.length === 0 ||
              entry.sourceRefs.some(
                (ref) => ref.runId !== source.runId || ref.threadId !== source.threadId,
              ) ||
              entry.scope !== (source.branch === null ? "project" : "branch") ||
              entry.branch !== source.branch ||
              entry.contradictsEntryIds.some(
                (id) => !currentEntries.some((existing) => existing.id === id),
              ),
          )
        )
          return yield* new MonarchScheduleError({ reason: "generation_failed" });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireClaim(run);
            const fresh = yield* context.get({ projectId });
            if (
              fresh.revision !== state.revision ||
              fresh.settings.paused ||
              (yield* targetFingerprint(projectId)) !== targetsAtCapture
            )
              return yield* new MonarchScheduleError({ reason: "conflict" });
            const originalScope = yield* context.sourceScope({
              projectId,
              runId: source.runId,
              threadId: source.threadId,
            });
            if (
              originalScope.branch !== source.branch ||
              originalScope.worktreePath !== source.worktreePath
            )
              return yield* new MonarchScheduleError({ reason: "conflict" });
            const materialJson = yield* encodeContext(material);
            const modelJson = yield* encodeContext(selection);
            const recordedAt = yield* nowIso;
            if (saved) {
              yield* sql`UPDATE monarch_run_journals SET revision=${revision},entries_json=${materialJson},review_run_id=${run.id},
                model_json=${modelJson},started_at=${startedAt},recorded_at=${recordedAt}
                WHERE project_id=${projectId} AND run_id=${source.runId} AND revision=${saved.revision}`;
            } else {
              yield* sql`INSERT INTO monarch_run_journals(project_id,run_id,thread_id,completed_at,branch,worktree_path,entries_json,review_run_id,model_json,started_at,recorded_at,revision)
                VALUES(${projectId},${source.runId},${source.threadId},${source.completedAt},${source.branch},${source.worktreePath},${materialJson},${run.id},${modelJson},${startedAt},${recordedAt},${revision})`;
            }
          }),
        );
        entries.push(...material);
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requireClaim(run);
          if ((yield* targetFingerprint(projectId)) !== targetsAtCapture)
            return yield* new MonarchScheduleError({ reason: "conflict" });
          const updated = yield* context.applyGenerated({
            projectId,
            expectedRevision: state.revision,
            generationId: run.id,
            entries,
          });
          const entryIds = updated.entries
            .filter((entry) => entry.generationId === run.id)
            .map((entry) => entry.id);
          yield* sql`UPDATE monarch_continuity_sources SET captured=1 WHERE project_id=${projectId} AND journal_revision=${run.journalRevision ?? 1} AND run_id IN ${sql.in(run.sourceRunIds!)}`;
          yield* sql`UPDATE monarch_review_runs SET payload_json=${yield* encodeRun({ ...run, contextRevision: updated.revision, contextEntryIds: entryIds, summary })} WHERE id=${run.id}`;
          yield* sql`UPDATE monarch_review_stages SET status='succeeded',completed_at=${yield* nowIso} WHERE review_run_id=${run.id} AND stage='journal'`;
          return { state: updated, entryIds, summary };
        }),
      );
    },
    Effect.mapError((cause) =>
      isScheduleError(cause)
        ? cause
        : new MonarchScheduleError({ reason: "generation_failed", cause }),
    ),
  );

  const reviewScope = Effect.fn("MonarchScheduler.reviewScope")(function* (
    run: MonarchScheduleRun,
    excluded: ReadonlyArray<ThreadId>,
  ) {
    const origin = run.reviewScopeRunId ?? run.sourceRunIds?.[0];
    if (!origin) return null;
    const [source] = yield* completedSources(run.projectId, excluded, [origin], 1);
    return source?.scopeKnown ? source : null;
  });

  const recentJournals = Effect.fn("MonarchScheduler.recentJournals")(function* (
    state: MonarchContextState,
    scope: { branch: string | null; worktreePath: string | null } | null,
  ) {
    const excluded = state.settings.excludedThreadIds;
    const rows = yield* sql<{
      runId: RunId;
      threadId: ThreadId;
      branch: string | null;
      worktreePath: string | null;
      completedAt: string;
      revision: number;
      entries_json: string;
    }>`
      SELECT j.run_id AS runId,j.thread_id AS threadId,j.branch,j.worktree_path AS worktreePath,j.completed_at AS completedAt,j.revision,j.entries_json
      FROM monarch_run_journals j
      JOIN orchestration_v2_projection_threads t ON t.thread_id=j.thread_id AND t.project_id=j.project_id
      JOIN orchestration_v2_projection_runs r ON r.run_id=j.run_id AND r.thread_id=j.thread_id
      WHERE j.project_id=${state.projectId} AND r.status='completed' AND t.deleted_at IS NULL AND j.entries_json!='[]'
        AND ((j.branch IS NULL AND j.worktree_path IS NULL) OR (j.branch=${scope?.branch ?? null} AND j.worktree_path IS ${scope?.worktreePath ?? null}))
        AND ${excluded.length ? sql`j.thread_id NOT IN ${sql.in(excluded)}` : sql`1`}
      ORDER BY j.completed_at DESC,j.run_id DESC LIMIT 10`;
    const journals = yield* Effect.forEach(rows, ({ entries_json, ...source }) =>
      decodeJournalEntries(entries_json).pipe(
        Effect.map((entries) => ({ ...source, evidence: "reported" as const, entries })),
      ),
    );
    const known = new Set(state.entries.map(MonarchContextService.materialKey));
    const keys = journals.flatMap((journal) =>
      journal.entries.map(MonarchContextService.materialKey),
    );
    const historical = keys.length
      ? yield* sql<{ material_key: string }>`SELECT material_key FROM monarch_context_material_keys
      WHERE project_id=${state.projectId} AND material_key IN ${sql.in(keys)}`
      : [];
    const superseded = new Set(
      historical.map((row) => row.material_key).filter((key) => !known.has(key)),
    );
    return journals
      .map((journal) => ({
        ...journal,
        entries: journal.entries.filter(
          (entry) =>
            !superseded.has(MonarchContextService.materialKey(entry)) &&
            entry.contradictsEntryIds.every((id) =>
              state.entries.some((existing) => existing.id === id),
            ),
        ),
      }))
      .filter((journal) => journal.entries.length > 0);
  });

  const generate = Effect.fn("MonarchScheduler.generate")(
    function* (schedule: MonarchReviewSchedule, run: MonarchScheduleRun) {
      const currentProject = yield* project(schedule.projectId);
      if (currentProject.archived_at !== null)
        return yield* new MonarchScheduleError({ reason: "not_found" });
      const captured = yield* captureContext(schedule, run);
      const contextState = captured.state;
      const state = yield* monarch.list({ projectId: schedule.projectId });
      const targets = state.targets.filter((target) => target.status === "active").slice(0, 20);
      const availableSlots =
        (contextState.settings.modelSelection !== null || contextState.settings.enabled
          ? contextState.settings.maxOpenSuggestions
          : 100) - state.suggestions.filter((s) => s.status === "suggested").length;
      const metadata = {
        contextRevision: contextState.revision,
        contextEntryIds: captured.entryIds,
        summary: captured.summary,
        targetFingerprint: yield* targetFingerprint(schedule.projectId),
      };
      if (run.updateSuggestions === false || targets.length === 0 || availableSlots <= 0)
        return { ...metadata, suggestions: [] };
      // A completed conversational reply alone is not a meaningful project outcome.
      if (run.trigger === "work-completed" && run.updateContext && captured.entryIds.length === 0)
        return { ...metadata, suggestions: [] };
      const scope = yield* reviewScope(run, contextState.settings.excludedThreadIds);
      const evidence = yield* recentJournals(contextState, scope);
      yield* startStage(run, "suggestions", schedule.modelSelection, []);
      const provider = yield* selectedProvider(schedule.modelSelection, schedule.projectId);
      const work = yield* activeWork(schedule.projectId, contextState.settings.excludedThreadIds);
      const brief = yield* context.brief({
        projectId: schedule.projectId,
        branch: scope?.branch ?? null,
      });
      const promptContext = yield* encodeReviewContext({
        project: currentProject.title.slice(0, 200),
        reviewInstructions: schedule.instructions,
        projectContext: brief,
        projectInstructions: contextState.settings.instructions,
        activeWork: work,
        targets: targets.map((target) => ({
          id: target.id,
          revision: target.revision,
          title: target.title,
          description: target.description.slice(0, 3000),
          indicators: target.indicators.slice(0, 5).map((v) => v.slice(0, 500)),
          constraints: target.constraints.slice(0, 5).map((v) => v.slice(0, 500)),
        })),
        completedTurnJournals: evidence,
        existingSuggestions: [
          ...state.suggestions
            .filter(
              (s) =>
                s.status === "suggested" &&
                !s.sourceThreadIds.some((id) =>
                  contextState.settings.excludedThreadIds.includes(id),
                ),
            )
            .slice(0, 30),
          ...state.suggestions
            .filter(
              (s) =>
                s.status !== "suggested" &&
                !s.sourceThreadIds.some((id) =>
                  contextState.settings.excludedThreadIds.includes(id),
                ),
            )
            .slice(0, 20),
        ].map((s) => ({ title: s.title, prompt: s.prompt.slice(0, 1000), status: s.status })),
      });
      yield* sql`UPDATE monarch_review_stages SET source_run_ids_json=${yield* encodeContext(evidence.map((source) => source.runId))},
        source_refs_json=${yield* encodeContext(evidence.map(({ runId, revision }) => ({ runId, revision })))}
        WHERE review_run_id=${run.id} AND stage='suggestions'`;
      const response = yield* provider.generateProjectSuggestions!({
        cwd: currentProject.workspace_root,
        modelSelection: schedule.modelSelection,
        context: promptContext,
      });
      // Reject invented evidence instead of silently laundering it into a suggestion.
      const targetById = new Map(targets.map((target) => [target.id, target]));
      const threadIds = new Set(evidence.map((thread) => thread.threadId));
      if (
        response.suggestions.length > 3 ||
        response.suggestions.some(
          (s) =>
            s.targetIds.length === 0 ||
            s.targetIds.some((id) => !targetById.has(id)) ||
            s.sourceThreadIds.some((id) => !threadIds.has(ThreadId.make(id))),
        )
      ) {
        return yield* new MonarchScheduleError({ reason: "generation_failed" });
      }
      const titles = new Set(state.suggestions.map((s) => normalizeSuggestionText(s.title)));
      const prompts = new Set(state.suggestions.map((s) => normalizeSuggestionText(s.prompt)));
      const suggestions = response.suggestions
        .filter((suggestion) => {
          const title = normalizeSuggestionText(suggestion.title);
          const prompt = normalizeSuggestionText(suggestion.prompt);
          if (titles.has(title) || prompts.has(prompt)) return false;
          titles.add(title);
          prompts.add(prompt);
          return true;
        })
        .slice(0, availableSlots)
        .map((suggestion) => ({
          projectId: schedule.projectId,
          title: suggestion.title,
          prompt: suggestion.prompt,
          rationale: suggestion.rationale,
          targets: [...new Set(suggestion.targetIds)].map((id) => ({
            targetId: id,
            revision: targetById.get(id)!.revision,
          })),
          sourceThreadIds: [...new Set(suggestion.sourceThreadIds)].map((id) => ThreadId.make(id)),
          modelSelection: schedule.modelSelection,
          contextRevision: contextState.revision,
        }));
      return { ...metadata, suggestions };
    },
    Effect.mapError((cause) =>
      isScheduleError(cause)
        ? cause
        : new MonarchScheduleError({ reason: "generation_failed", cause }),
    ),
  );

  const finish = Effect.fn("MonarchScheduler.finish")(function* (
    run: MonarchScheduleRun,
    result: Exit.Exit<Effect.Success<ReturnType<typeof generate>>, MonarchScheduleError>,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const { schedule, activeRunId } = yield* read({
          id: run.scheduleId,
          projectId: run.projectId,
        });
        if (activeRunId !== run.id) return;
        const now = yield* nowIso;
        const interrupted = Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause);
        const status = Exit.isSuccess(result)
          ? "succeeded"
          : interrupted
            ? "interrupted"
            : "failed";
        const [openStage] = yield* sql<{
          stage: string;
        }>`SELECT stage FROM monarch_review_stages WHERE review_run_id=${run.id} AND status='running'`;
        const stageName = openStage?.stage === "journal" ? "Journal" : "Review";
        const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : null;
        const error = Exit.isSuccess(result)
          ? null
          : interrupted
            ? `${stageName} interrupted. Retry when ready.`
            : isScheduleError(failure) && failure.reason === "provider_unavailable"
              ? `Choose an available ${stageName.toLowerCase()} model and reasoning option in Suggestion settings, then retry.`
              : `${stageName} failed. Check the project and selected provider, then retry.`;
        const suggestionIds: string[] = [];
        yield* sql`UPDATE monarch_review_stages SET status=${status},completed_at=${now},error=${error}
          WHERE review_run_id=${run.id} AND status='running'`;
        if (Exit.isSuccess(result)) {
          const currentContext = yield* context.get({ projectId: schedule.projectId });
          if (
            currentContext.settings.paused ||
            currentContext.revision !== result.value.contextRevision ||
            (yield* targetFingerprint(schedule.projectId)) !== result.value.targetFingerprint
          )
            return yield* new MonarchScheduleError({ reason: "conflict" });
          if (run.trigger !== "manual" && (yield* activeWork(schedule.projectId)).length > 0)
            return yield* new MonarchScheduleError({ reason: "busy" });
          const current = yield* monarch.list({ projectId: schedule.projectId });
          const slots = Math.max(
            0,
            (currentContext.settings.modelSelection !== null || currentContext.settings.enabled
              ? currentContext.settings.maxOpenSuggestions
              : 100) - current.suggestions.filter((s) => s.status === "suggested").length,
          );
          for (const suggestion of result.value.suggestions.slice(0, slots)) {
            const key = yield* digest.digestHex(
              Digest.sha256,
              new TextEncoder().encode(normalizeSuggestionText(suggestion.title)),
            );
            const created = yield* monarch.createSuggestion({
              ...suggestion,
              sourceRunId: run.id,
              dedupeKey: `review:${key}`,
            });
            if (created.sourceRunId === run.id) suggestionIds.push(created.id);
          }
        }
        const [storedRow] =
          yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE id=${run.id}`;
        const storedRun = storedRow ? yield* decodeRun(storedRow.payload_json) : run;
        const completed: MonarchScheduleRun = {
          ...storedRun,
          completedAt: now,
          status,
          error,
          suggestionIds,
          ...(Exit.isSuccess(result)
            ? {
                contextRevision: result.value.contextRevision,
                contextEntryIds: result.value.contextEntryIds,
                summary: result.value.summary,
              }
            : {}),
        };
        yield* sql`UPDATE monarch_review_runs SET status = ${status}, payload_json = ${yield* encodeRun(completed)} WHERE id = ${run.id}`;
        yield* save({ ...schedule, lastRunStatus: status, lastRunError: error });
        yield* sql`UPDATE monarch_review_schedules SET active_run_id = NULL WHERE id = ${schedule.id} AND active_run_id = ${run.id}`;
        if (run.requestVersion !== undefined) {
          yield* sql`UPDATE monarch_continuity_queue SET completed_version=MAX(completed_version,${Exit.isSuccess(result) ? run.requestVersion : 0}),last_error=${error}
            WHERE project_id=${run.projectId}`;
          if (Exit.isSuccess(result)) {
            const latestContext = yield* context.get({ projectId: run.projectId });
            const [remaining] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM monarch_continuity_sources WHERE project_id=${run.projectId} AND captured=0 AND ${latestContext.settings.excludedThreadIds.length ? sql`thread_id NOT IN ${sql.in(latestContext.settings.excludedThreadIds)}` : sql`1`}`;
            if (run.updateContext && (remaining?.count ?? 0) > 0) {
              const followup =
                run.trigger === "retry"
                  ? latestContext.settings.enabled && latestContext.settings.autoUpdateContext
                    ? "work-completed"
                    : "build-context"
                  : run.trigger;
              const explicit = followup === "build-context" || followup === "refresh";
              const suggest =
                followup === "refresh"
                  ? 1
                  : !explicit && latestContext.settings.suggestAfterWork
                    ? 2
                    : 0;
              yield* sql`UPDATE monarch_continuity_queue SET
                trigger=CASE WHEN requested_version<=attempted_version THEN ${followup} ELSE trigger END,
                requested_version=MAX(requested_version,attempted_version+1),update_context=update_context | ${explicit ? 1 : 2},
                update_suggestions=update_suggestions | ${suggest}
                WHERE project_id=${run.projectId}`;
            }
          }
        }
        // Runs that produced suggestions remain as provenance, even beyond the recent history window.
        yield* sql`DELETE FROM monarch_review_runs WHERE schedule_id = ${schedule.id}
          AND json_array_length(payload_json, '$.suggestionIds') = 0
          AND COALESCE(json_array_length(payload_json,'$.contextEntryIds'),0)=0
          AND NOT EXISTS (SELECT 1 FROM monarch_review_stages WHERE review_run_id=monarch_review_runs.id)
          AND id NOT IN
        (SELECT id FROM monarch_review_runs WHERE schedule_id = ${schedule.id} ORDER BY started_at DESC, id DESC LIMIT 100)`;
      }),
    );
    yield* notify;
  }, Effect.mapError(storageError));

  const execute = Effect.fn("MonarchScheduler.execute")(function* (
    schedule: MonarchReviewSchedule,
    run: MonarchScheduleRun,
  ) {
    // Claim-to-finalizer is uninterruptible; cancellation still interrupts the provider call.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* restore(
          generate(schedule, run).pipe(
            Effect.timeoutOrElse({
              duration: RUN_TIMEOUT_MS,
              orElse: () => Effect.fail(new MonarchScheduleError({ reason: "generation_failed" })),
            }),
          ),
        ).pipe(Effect.exit);
        yield* finish(run, result).pipe(
          Effect.catch((cause) =>
            // Invalid/stale target references roll the result transaction back, then record failure.
            finish(run, Exit.fail(cause)),
          ),
        );
      }),
    );
  });

  const claim = Effect.fn("MonarchScheduler.claim")(function* (
    input: MonarchScheduleIdentity,
    trigger: MonarchScheduleRun["trigger"],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { schedule: storedSchedule, activeRunId, managed } = yield* read(input);
        let schedule = storedSchedule;
        if (activeRunId !== null) return yield* new MonarchScheduleError({ reason: "busy" });
        const [capacity] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM monarch_review_runs WHERE status = 'running'`;
        if ((capacity?.count ?? 0) >= 2) return yield* new MonarchScheduleError({ reason: "busy" });
        const [projectBusy] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM monarch_review_runs WHERE project_id=${input.projectId} AND status='running'`;
        if ((projectBusy?.count ?? 0) > 0)
          return yield* new MonarchScheduleError({ reason: "busy" });
        const contextState = yield* context.get({ projectId: input.projectId });
        if (managed && contextState.settings.modelSelection)
          schedule = {
            ...schedule,
            modelSelection: contextState.settings.modelSelection,
            instructions: contextState.settings.instructions,
          };
        if (contextState.settings.paused)
          return yield* new MonarchScheduleError({ reason: "paused" });
        if (
          (managed ||
            contextState.settings.modelSelection !== null ||
            contextState.settings.enabled) &&
          (yield* dailyUsage(input.projectId)) >= contextState.settings.maxUpdatesPerDay
        )
          return yield* new MonarchScheduleError({ reason: "daily_limit" });
        if (trigger !== "manual" && (yield* activeWork(input.projectId)).length > 0)
          return yield* new MonarchScheduleError({ reason: "busy" });
        const now = yield* nowIso;
        if (
          trigger === "scheduled" &&
          (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now)
        )
          return null;
        const currentProject = yield* project(input.projectId);
        if (currentProject.archived_at !== null)
          return yield* new MonarchScheduleError({ reason: "not_found" });
        const [queue] =
          yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${input.projectId}`;
        if (managed && (!queue || queue.requested_version <= queue.attempted_version)) return null;
        if (managed && queue?.update_suggestions && !contextState.settings.modelSelection)
          return yield* new MonarchScheduleError({ reason: "paused" });
        if (managed)
          yield* sql`UPDATE monarch_continuity_sources SET captured=2 WHERE project_id=${input.projectId} AND captured=0 AND NOT EXISTS(
          SELECT 1 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id
          WHERE t.project_id=${input.projectId} AND t.thread_id=monarch_continuity_sources.thread_id AND t.deleted_at IS NULL
          AND r.run_id=monarch_continuity_sources.run_id AND r.status='completed')`;
        const [priorAttempt] =
          trigger === "retry"
            ? yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE schedule_id=${schedule.id}
          ORDER BY started_at DESC,rowid DESC LIMIT 1`
            : [];
        const retriedRun = priorAttempt ? yield* decodeRun(priorAttempt.payload_json) : null;
        const sourceRows = !managed
          ? []
          : yield* sql<{
              run_id: RunId;
              journal_revision: number;
            }>`SELECT run_id,journal_revision FROM monarch_continuity_sources WHERE project_id=${input.projectId} AND captured=0
          AND ${contextState.settings.excludedThreadIds.length ? sql`thread_id NOT IN ${sql.in(contextState.settings.excludedThreadIds)}` : sql`1`}
          AND ${retriedRun ? sql`run_id=${retriedRun.sourceRunIds?.[0] ?? retriedRun.reviewScopeRunId ?? null}` : sql`1`}
          ORDER BY event_sequence,run_id LIMIT 1`;
        const scopeSource =
          retriedRun?.reviewScopeRunId ?? retriedRun?.sourceRunIds?.[0] ?? sourceRows[0]?.run_id;
        const run: MonarchScheduleRun = {
          id: `review-run:${yield* random.uuidV4()}`,
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          trigger,
          scheduledFor: trigger === "scheduled" ? schedule.nextRunAt : null,
          startedAt: now,
          completedAt: null,
          status: "running",
          error: null,
          modelSelection: schedule.modelSelection,
          suggestionIds: [],
          ...(retriedRun ? { retryOfRunId: retriedRun.id } : {}),
          ...(scopeSource ? { reviewScopeRunId: scopeSource } : {}),
          ...(sourceRows[0] ? { journalRevision: sourceRows[0].journal_revision } : {}),
          sourceRunIds: sourceRows.map((source) => source.run_id),
          contextRevision: contextState.revision,
          // Queue capability bits retain explicit/manual (1), completed work (2), and Target (4) causes.
          updateContext:
            managed &&
            !!queue &&
            ((queue.update_context & 1) !== 0 ||
              ((queue.update_context & 2) !== 0 &&
                contextState.settings.enabled &&
                contextState.settings.autoUpdateContext)),
          updateSuggestions: managed
            ? !!queue &&
              ((queue.update_suggestions & 1) !== 0 ||
                (contextState.settings.enabled &&
                  (((queue.update_suggestions & 2) !== 0 &&
                    contextState.settings.suggestAfterWork) ||
                    ((queue.update_suggestions & 4) !== 0 &&
                      contextState.settings.suggestAfterTargetChange))))
            : true,
          ...(managed && queue ? { requestVersion: queue.requested_version } : {}),
        };
        // Advance from now, not the old due time. Offline gaps produce at most one review.
        const updated: MonarchReviewSchedule = {
          ...schedule,
          lastRunAt: now,
          lastRunStatus: "running",
          lastRunError: null,
          runCount: schedule.runCount + 1,
          nextRunAt:
            trigger === "scheduled"
              ? nextMonarchReviewAt(schedule.recurrence, schedule.timezone, now)
              : schedule.nextRunAt,
        };
        const rows =
          yield* sql`UPDATE monarch_review_schedules SET active_run_id = ${run.id}, next_run_at = ${updated.nextRunAt},
        payload_json = ${yield* encodeSchedule(updated)} WHERE id = ${schedule.id} AND active_run_id IS NULL RETURNING id`;
        if (rows.length === 0) return yield* new MonarchScheduleError({ reason: "busy" });
        const leaseUntil = DateTime.formatIso(
          DateTime.addDuration(DateTime.makeUnsafe(now), RUN_LEASE_MS),
        );
        yield* sql`INSERT INTO monarch_review_runs (id, schedule_id, project_id, status, started_at, lease_until, payload_json)
        VALUES (${run.id}, ${schedule.id}, ${schedule.projectId}, 'running', ${now}, ${leaseUntil}, ${yield* encodeRun(run)})`;
        // Retire the entire committed backlog when capture is off. New arrivals after
        // this transaction remain pending; a later explicit Build may revive ignored sources.
        if (managed && !run.updateContext && !retriedRun)
          yield* sql`UPDATE monarch_continuity_sources SET captured=2 WHERE project_id=${input.projectId} AND captured=0`;
        if (managed && queue)
          yield* sql`UPDATE monarch_continuity_queue SET attempted_version=requested_version,update_context=0,update_suggestions=0 WHERE project_id=${input.projectId}`;
        return { schedule: updated, run };
      }),
    );
  }, Effect.mapError(storageError));

  const dispatch = Effect.fn("MonarchScheduler.dispatch")(function* (
    input: MonarchScheduleIdentity,
    trigger: MonarchScheduleRun["trigger"],
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* claim(input, trigger);
        if (claimed === null) return null;
        yield* notify;
        yield* execute(claimed.schedule, claimed.run).pipe(
          // Dispatch masks cancellation until the claim has a scoped owner.
          // The owned provider call must still respond to timeout and shutdown.
          Effect.interruptible,
          Effect.catch((cause) =>
            Effect.logWarning("Project review completion could not be saved", { cause }),
          ),
          Effect.forkIn(scope),
        );
        return { runId: claimed.run.id };
      }),
    );
  });

  const runNow = Effect.fn("MonarchScheduler.runNow")(function* (input: MonarchScheduleIdentity) {
    const { schedule } = yield* read(input);
    yield* selectedProvider(schedule.modelSelection, schedule.projectId);
    return (yield* dispatch(input, "manual"))!;
  });

  const refresh = Effect.fn("MonarchScheduler.refresh")(function* (
    raw: MonarchProjectRefreshInput,
  ) {
    const input = yield* decodeRefresh(raw).pipe(
      Effect.mapError((cause) => new MonarchScheduleError({ reason: "invalid", cause })),
    );
    if ((yield* project(input.projectId)).archived_at !== null)
      return yield* new MonarchScheduleError({ reason: "not_found" });
    const state = yield* context.get({ projectId: input.projectId });
    if (
      (input.mode === "build-context" && !input.threadIds?.length) ||
      (input.reanalyze && input.mode !== "build-context")
    )
      return yield* new MonarchScheduleError({ reason: "invalid" });
    const queue = yield* ensureQueue(
      state,
      state.settings.journalModelSelection ?? DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION,
    );
    const candidates =
      input.mode === "build-context" && input.threadIds?.length
        ? yield* completedSources(input.projectId, state.settings.excludedThreadIds, undefined, 50)
        : [];
    if (input.threadIds?.some((id) => !candidates.some((source) => source.threadId === id)))
      return yield* new MonarchScheduleError({ reason: "invalid" });
    const selected = candidates.filter((source) => input.threadIds?.includes(source.threadId));
    const pending = yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const source of selected) {
          const [saved] = yield* sql<{
            revision: number;
          }>`SELECT revision FROM monarch_run_journals WHERE project_id=${input.projectId} AND run_id=${source.runId}`;
          if (saved && !input.reanalyze) continue;
          yield* enqueueSources(input.projectId, [source]);
          yield* sql`UPDATE monarch_continuity_sources SET captured=0,journal_revision=${(saved?.revision ?? 0) + 1}
            WHERE project_id=${input.projectId} AND run_id=${source.runId}`;
        }
        let updateSuggestions = input.mode !== "build-context";
        if (input.mode === "retry") {
          if (
            (yield* read({ projectId: input.projectId, id: queue.schedule_id })).activeRunId !==
            null
          )
            return yield* new MonarchScheduleError({ reason: "busy" });
          const [last] =
            yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE project_id=${input.projectId} AND schedule_id=${queue.schedule_id} ORDER BY started_at DESC,rowid DESC LIMIT 1`;
          if (last)
            updateSuggestions = (yield* decodeRun(last.payload_json)).updateSuggestions !== false;
        }
        if (updateSuggestions && !state.settings.modelSelection)
          return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
        yield* sql`UPDATE monarch_continuity_queue SET requested_version=MAX(requested_version,attempted_version+1),trigger=${input.mode},
        update_context=update_context | 1,update_suggestions=update_suggestions | ${updateSuggestions ? 1 : 0},last_error=NULL WHERE project_id=${input.projectId}`;
        const [updated] =
          yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${input.projectId}`;
        return updated!;
      }),
    );
    yield* notify;
    return {
      jobId: `${queue.schedule_id}:${pending.requested_version}`,
      status: "queued" as const,
    };
  }, Effect.mapError(storageError));

  const activity = Effect.fn("MonarchScheduler.activity")(function* (input: {
    readonly projectId: ProjectId;
  }): Effect.fn.Return<MonarchProjectActivityResult, MonarchScheduleError> {
    yield* project(input.projectId);
    const state = yield* context.get(input).pipe(Effect.mapError(storageError));
    const [queue] =
      yield* sql<ContinuityQueue>`SELECT * FROM monarch_continuity_queue WHERE project_id=${input.projectId}`.pipe(
        Effect.mapError(storageError),
      );
    const rows =
      yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE project_id=${input.projectId} ORDER BY started_at DESC,id DESC LIMIT 100`.pipe(
        Effect.mapError(storageError),
      );
    const runs = yield* Effect.forEach(rows, (row) => decodeRun(row.payload_json)).pipe(
      Effect.mapError(storageError),
    );
    const updatesToday = yield* dailyUsage(input.projectId);
    const pending = !!queue && queue.requested_version > queue.completed_version;
    const automaticPending =
      !!queue &&
      queue.requested_version > queue.attempted_version &&
      ((queue.update_context | queue.update_suggestions) & 1) === 0;
    const blockedReason =
      state.settings.paused ||
      (pending && !!queue?.update_suggestions && state.settings.modelSelection === null) ||
      (automaticPending && !state.settings.enabled)
        ? "paused"
        : pending && queue?.last_error && queue.requested_version <= queue.attempted_version
          ? "failed"
          : pending && updatesToday >= state.settings.maxUpdatesPerDay
            ? "daily-limit"
            : pending && (yield* activeWork(input.projectId)).length > 0
              ? "active-work"
              : null;
    return {
      pending,
      blockedReason,
      updatesToday,
      maxUpdatesPerDay: state.settings.maxUpdatesPerDay,
      runs,
    };
  });

  const tick = Effect.fn("MonarchScheduler.tick")(function* () {
    const now = yield* nowIso;
    const expired =
      yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE status = 'running' AND lease_until <= ${now} LIMIT 50`;
    for (const row of expired) {
      const run = yield* decodeRun(row.payload_json);
      // Expired claims may be from a crashed process. They are never dispatched again.
      yield* finish(run, Exit.interrupt());
    }
    yield* discover();
    const pending =
      yield* sql<ContinuityQueue>`SELECT q.* FROM monarch_continuity_queue q JOIN monarch_project_context c ON c.project_id=q.project_id
      JOIN projection_projects p ON p.project_id=q.project_id
      WHERE q.requested_version>q.attempted_version AND p.deleted_at IS NULL AND p.archived_at IS NULL
        AND (json_extract(c.settings_json,'$.enabled')=1 OR ((q.update_context | q.update_suggestions) & 1) != 0)
      ORDER BY q.project_id LIMIT 20`;
    for (const queued of pending) {
      yield* dispatch(
        { projectId: queued.project_id, id: queued.schedule_id },
        queued.trigger,
      ).pipe(
        Effect.catch((cause) =>
          cause.reason === "busy" || cause.reason === "paused" || cause.reason === "daily_limit"
            ? Effect.void
            : Effect.logWarning("Project continuity dispatch failed", { cause }),
        ),
      );
    }
    const due = yield* sql<{ id: string; project_id: ProjectId }>`
      SELECT s.id, s.project_id FROM monarch_review_schedules s
      JOIN projection_projects p ON p.project_id = s.project_id
      WHERE s.enabled = 1 AND s.next_run_at <= ${now} AND s.active_run_id IS NULL
        AND s.deleted_at IS NULL
        AND s.managed = 0
        AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY s.next_run_at LIMIT 20`;
    yield* Effect.forEach(
      due,
      (row) =>
        dispatch({ id: row.id, projectId: row.project_id }, "scheduled").pipe(
          Effect.catch((cause) =>
            cause.reason === "busy" || cause.reason === "paused" || cause.reason === "daily_limit"
              ? Effect.void
              : Effect.logWarning("Project review dispatch failed", { cause }),
          ),
        ),
      { discard: true },
    );
  }, Effect.mapError(storageError));

  yield* scheduler.register("monarch-project-reviews", tick());

  return MonarchScheduler.of({
    list,
    upsert,
    setEnabled,
    remove,
    runNow,
    history,
    refresh,
    activity,
    sources,
    watchActivity: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.merge(
            Stream.fromSubscription(subscription),
            context.watch(input).pipe(
              Stream.map(() => undefined),
              Stream.mapError(storageError),
            ),
          ).pipe(Stream.mapEffect(() => activity(input)));
        }),
      ),
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

export const layer = Layer.effect(MonarchScheduler, make);
