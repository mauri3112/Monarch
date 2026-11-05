import {
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  MonarchReviewSchedule,
  MonarchScheduleError,
  MonarchScheduleRun,
  MonarchSchedulesUpsertInput,
  MONARCH_REVIEW_DRIVER_KINDS,
  ThreadId,
  type ModelSelection,
  type MonarchScheduleIdentity,
  type MonarchScheduleRecurrence,
  type MonarchSchedulesRemoveInput,
  type MonarchSchedulesSetEnabledInput,
  type ProjectId,
} from "@t3tools/contracts";
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
  }
>()("t3/monarch/MonarchScheduler") {}

type PayloadRow = { readonly payload_json: string };
type ScheduleRow = PayloadRow & {
  readonly active_run_id: string | null;
  readonly deleted_at: string | null;
};
const decodeSchedule = Schema.decodeEffect(Schema.fromJsonString(MonarchReviewSchedule));
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(MonarchReviewSchedule));
const decodeRun = Schema.decodeEffect(Schema.fromJsonString(MonarchScheduleRun));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(MonarchScheduleRun));
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUpsert = Schema.decodeEffect(MonarchSchedulesUpsertInput);
const isScheduleError = Schema.is(MonarchScheduleError);
const storageError = (cause: unknown) =>
  isScheduleError(cause) ? cause : new MonarchScheduleError({ reason: "persistence", cause });
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
// A lease outlives the bounded provider call. Expired work is recorded, never replayed.
const RUN_LEASE_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 4 * 60_000;
const MAX_SCHEDULES_PER_PROJECT = 50;
const REVIEW_DRIVERS = new Set<string>(MONARCH_REVIEW_DRIVER_KINDS);
const normalizeSuggestionText = (text: string) =>
  text.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  const monarch = yield* MonarchService.MonarchService;
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
  ) {
    const configuration = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new MonarchScheduleError({ reason: "provider_unavailable", cause }),
      ),
    );
    if (!resolveProjectProviderInstanceEnabled(configuration, projectId, selection.instanceId))
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    const instance = yield* registry.getInstance(selection.instanceId);
    if (!instance?.textGeneration.generateProjectSuggestions) {
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (
      !REVIEW_DRIVERS.has(snapshot.driver) ||
      !snapshot.enabled ||
      !snapshot.installed ||
      snapshot.auth.status === "unauthenticated" ||
      !isProviderAvailable(snapshot) ||
      !snapshot.models.some(
        (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
      )
    ) {
      return yield* new MonarchScheduleError({ reason: "provider_unavailable" });
    }
    return instance.textGeneration.generateProjectSuggestions;
  });

  const read = Effect.fn("MonarchScheduler.read")(function* (
    input: MonarchScheduleIdentity,
    includeRemoved = false,
  ) {
    const [row] =
      yield* sql<ScheduleRow>`SELECT payload_json, active_run_id, deleted_at FROM monarch_review_schedules
      WHERE id = ${input.id} AND project_id = ${input.projectId}`;
    if (!row || (!includeRemoved && row.deleted_at !== null))
      return yield* new MonarchScheduleError({ reason: "not_found" });
    return { schedule: yield* decodeSchedule(row.payload_json), activeRunId: row.active_run_id };
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
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL ORDER BY id LIMIT ${MAX_SCHEDULES_PER_PROJECT}`;
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
          }>`SELECT COUNT(*) AS count FROM monarch_review_schedules WHERE project_id = ${input.projectId} AND deleted_at IS NULL`;
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

  const generate = Effect.fn("MonarchScheduler.generate")(
    function* (schedule: MonarchReviewSchedule) {
      const currentProject = yield* project(schedule.projectId);
      if (currentProject.archived_at !== null)
        return yield* new MonarchScheduleError({ reason: "not_found" });
      const invoke = yield* selectedProvider(schedule.modelSelection, schedule.projectId);
      const state = yield* monarch.list({ projectId: schedule.projectId });
      const targets = state.targets.filter((target) => target.status === "active").slice(0, 20);
      const availableSlots = 100 - state.suggestions.filter((s) => s.status === "suggested").length;
      if (targets.length === 0 || availableSlots <= 0) return [];
      const threads = yield* sql<{
        thread_id: string;
        title: string;
        run_id: string;
        completed_at: string;
      }>`
      SELECT t.thread_id, substr(t.title, 1, 200) AS title, r.run_id, r.completed_at
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
      WHERE t.project_id = ${schedule.projectId} AND t.deleted_at IS NULL
        AND r.ordinal = (SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest WHERE latest.thread_id = t.thread_id)
        AND r.status = 'completed' AND r.completed_at IS NOT NULL
      ORDER BY r.completed_at DESC LIMIT 10`;
      const evidence = yield* Effect.forEach(threads, (thread) =>
        Effect.gen(function* () {
          const messages = yield* sql<{ role: string; text: string }>`
        SELECT role, substr(json_extract(payload_json, '$.text'), 1, 3000) AS text
        FROM orchestration_v2_projection_messages WHERE thread_id = ${thread.thread_id}
          AND run_id = ${thread.run_id} AND role IN ('user', 'assistant') AND streaming = 0
        ORDER BY created_at DESC, message_id DESC LIMIT 2`;
          return {
            threadId: thread.thread_id,
            title: thread.title,
            completedAt: thread.completed_at,
            messages: messages.toReversed(),
          };
        }),
      );
      const response = yield* invoke({
        cwd: currentProject.workspace_root,
        modelSelection: schedule.modelSelection,
        context: yield* encodeContext({
          project: currentProject.title.slice(0, 200),
          reviewInstructions: schedule.instructions,
          targets: targets.map((target) => ({
            id: target.id,
            revision: target.revision,
            title: target.title,
            description: target.description.slice(0, 3000),
            indicators: target.indicators.slice(0, 5).map((v) => v.slice(0, 500)),
            constraints: target.constraints.slice(0, 5).map((v) => v.slice(0, 500)),
          })),
          completedThreads: evidence,
          existingSuggestions: [
            ...state.suggestions.filter((s) => s.status === "suggested").slice(0, 30),
            ...state.suggestions.filter((s) => s.status !== "suggested").slice(0, 20),
          ].map((s) => ({ title: s.title, prompt: s.prompt.slice(0, 1000), status: s.status })),
        }),
      });
      // Reject invented evidence instead of silently laundering it into a suggestion.
      const targetById = new Map(targets.map((target) => [target.id, target]));
      const threadIds = new Set(threads.map((thread) => thread.thread_id));
      if (
        response.suggestions.length > 3 ||
        response.suggestions.some(
          (s) =>
            s.targetIds.length === 0 ||
            s.targetIds.some((id) => !targetById.has(id)) ||
            s.sourceThreadIds.some((id) => !threadIds.has(id)),
        )
      ) {
        return yield* new MonarchScheduleError({ reason: "generation_failed" });
      }
      const titles = new Set(state.suggestions.map((s) => normalizeSuggestionText(s.title)));
      const prompts = new Set(state.suggestions.map((s) => normalizeSuggestionText(s.prompt)));
      return response.suggestions
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
        }));
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
        const error = Exit.isSuccess(result)
          ? null
          : interrupted
            ? "Review interrupted. It will not be replayed."
            : "Review failed. Check the selected provider and try Run now.";
        const suggestionIds: string[] = [];
        if (Exit.isSuccess(result)) {
          const current = yield* monarch.list({ projectId: schedule.projectId });
          const slots = Math.max(
            0,
            100 - current.suggestions.filter((s) => s.status === "suggested").length,
          );
          for (const suggestion of result.value.slice(0, slots)) {
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
        const completed: MonarchScheduleRun = {
          ...run,
          completedAt: now,
          status,
          error,
          suggestionIds,
        };
        yield* sql`UPDATE monarch_review_runs SET status = ${status}, payload_json = ${yield* encodeRun(completed)} WHERE id = ${run.id}`;
        yield* save({ ...schedule, lastRunStatus: status, lastRunError: error });
        yield* sql`UPDATE monarch_review_schedules SET active_run_id = NULL WHERE id = ${schedule.id} AND active_run_id = ${run.id}`;
        // Runs that produced suggestions remain as provenance, even beyond the recent history window.
        yield* sql`DELETE FROM monarch_review_runs WHERE schedule_id = ${schedule.id}
          AND json_array_length(payload_json, '$.suggestionIds') = 0 AND id NOT IN
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
          generate(schedule).pipe(
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
    trigger: "manual" | "scheduled",
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { schedule, activeRunId } = yield* read(input);
        if (activeRunId !== null) return yield* new MonarchScheduleError({ reason: "busy" });
        const [capacity] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM monarch_review_runs WHERE status = 'running'`;
        if ((capacity?.count ?? 0) >= 2) return yield* new MonarchScheduleError({ reason: "busy" });
        const now = yield* nowIso;
        if (
          trigger === "scheduled" &&
          (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now)
        )
          return null;
        const currentProject = yield* project(input.projectId);
        if (currentProject.archived_at !== null)
          return yield* new MonarchScheduleError({ reason: "not_found" });
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
        return { schedule: updated, run };
      }),
    );
  }, Effect.mapError(storageError));

  const dispatch = Effect.fn("MonarchScheduler.dispatch")(function* (
    input: MonarchScheduleIdentity,
    trigger: "manual" | "scheduled",
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

  const tick = Effect.fn("MonarchScheduler.tick")(function* () {
    const now = yield* nowIso;
    const expired =
      yield* sql<PayloadRow>`SELECT payload_json FROM monarch_review_runs WHERE status = 'running' AND lease_until <= ${now} LIMIT 50`;
    for (const row of expired) {
      const run = yield* decodeRun(row.payload_json);
      // Expired claims may be from a crashed process. They are never dispatched again.
      yield* finish(run, Exit.interrupt());
    }
    const due = yield* sql<{ id: string; project_id: ProjectId }>`
      SELECT s.id, s.project_id FROM monarch_review_schedules s
      JOIN projection_projects p ON p.project_id = s.project_id
      WHERE s.enabled = 1 AND s.next_run_at <= ${now} AND s.active_run_id IS NULL
        AND s.deleted_at IS NULL
        AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY s.next_run_at LIMIT 20`;
    yield* Effect.forEach(
      due,
      (row) =>
        dispatch({ id: row.id, projectId: row.project_id }, "scheduled").pipe(
          Effect.catch((cause) =>
            cause.reason === "busy"
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
