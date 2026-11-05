import { assert, it } from "@effect/vitest";
import {
  MonarchScheduleRun,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MonarchScheduleIdentity,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MonarchService from "./MonarchService.ts";
import * as MonarchScheduler from "./MonarchScheduler.ts";

const projectId = ProjectId.make("review-fixture");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const at = "2026-11-05T00:00:00.000Z";
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(MonarchScheduleRun));

const base = MonarchService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
  Layer.provideMerge(Digest.layerWebCrypto),
);

const fixture = Effect.fn("MonarchSchedulerTest.fixture")(function* (
  invoke: NonNullable<ProviderTextGeneration["generateProjectSuggestions"]>,
) {
  yield* TestClock.setTime(Date.parse(at));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Synthetic project', '/tmp/monarch-review-fixture', '[]', ${at}, ${at})`;
  const monarch = yield* MonarchService.MonarchService;
  const target = yield* monarch.createTarget({
    projectId,
    title: "Reproducible analysis",
    description: "Other people can reproduce the analysis.",
    indicators: [],
    constraints: [],
    status: "active",
  });
  const tickRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const scheduler = Layer.succeed(Scheduler.Scheduler, {
    register: Effect.fn("TestScheduler.register")(function* <E, R>(
      _name: string,
      work: Effect.Effect<void, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      yield* Ref.set(tickRef, work.pipe(Effect.provideContext(context), Effect.orDie));
    }),
  });
  // The external provider boundary is the only mocked behavior. Persistence and planning are real.
  const registry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () =>
      Effect.succeed({
        textGeneration: { generateProjectSuggestions: invoke },
        snapshot: {
          getSnapshot: Effect.succeed({
            driver: "codex",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "test-model" }],
          }),
        },
      } as unknown as ProviderInstance),
  });
  const layer = MonarchScheduler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        scheduler,
        registry,
        ServerSettings.layerTest(),
        Layer.succeed(MonarchService.MonarchService, monarch),
      ),
    ),
  );
  const tick = Ref.get(tickRef).pipe(Effect.flatMap((work) => work));
  return { sql, monarch, target, layer, tick };
});

const create = (service: MonarchScheduler.MonarchScheduler["Service"]) =>
  service.upsert({
    projectId,
    title: "Morning project review",
    instructions: "Prefer small verifiable improvements.",
    recurrence: { type: "interval", everyMinutes: 15 },
    timezone: "Europe/Berlin",
    modelSelection,
    enabled: true,
  });
const waitForCompletion = (
  service: MonarchScheduler.MonarchScheduler["Service"],
  identity: MonarchScheduleIdentity,
) =>
  service.watch(identity).pipe(
    Stream.filter((state) =>
      state.schedules.some(
        (s) => s.id === identity.id && s.lastRunStatus !== "running" && s.lastRunStatus !== "idle",
      ),
    ),
    Stream.runHead,
  );

it.effect(
  "persists due work, prevents overlapping claims, and produces suggestions without starting a thread",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      let targetId = "";
      const f = yield* fixture((input) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1);
          yield* Deferred.succeed(started, input.context);
          yield* Deferred.await(release);
          return {
            suggestions: [
              {
                title: "Document inputs",
                prompt: "Create an input manifest after inspecting ingestion.",
                rationale: "An explicit manifest supports reproducibility.",
                targetIds: [targetId],
                sourceThreadIds: ["completed-source"],
              },
            ],
          };
        }),
      );
      targetId = f.target.id;
      yield* f.sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('completed-source', ${projectId}, 'Prepare ingestion', 'codex', 'approval-required', 'default', ${at}, ${at}, '{}')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
        VALUES ('completed-run', 'completed-source', 1, 'codex', 'completed', ${at}, ${at}, '{}')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('reply', 'completed-source', 'completed-run', 'assistant', 0, ${at}, ${at}, '{"text":"Ingestion exists but its input manifest remains undocumented."}')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('hidden', 'completed-source', 'completed-run', 'system', 0, ${at}, ${at}, '{"text":"SYSTEM_CONTEXT_MUST_STAY_PRIVATE"}')`;
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        const schedule = yield* create(service);
        assert.equal(schedule.nextRunAt, "2026-11-05T00:15:00.000Z");
        yield* f.tick;
        assert.equal(yield* Ref.get(calls), 0);
        yield* TestClock.setTime(Date.parse("2026-11-07T00:00:00.000Z"));
        yield* f.tick;
        const context = yield* Deferred.await(started);
        assert.include(context, "Reproducible analysis");
        assert.include(context, "input manifest remains undocumented");
        assert.notInclude(context, "SYSTEM_CONTEXT_MUST_STAY_PRIVATE");
        yield* Effect.all([f.tick, f.tick], { concurrency: "unbounded" });
        assert.equal((yield* service.runNow(schedule).pipe(Effect.flip)).reason, "busy");
        assert.equal(yield* Ref.get(calls), 1);
        const running = (yield* service.list({ projectId })).schedules[0]!;
        assert.equal(running.nextRunAt, "2026-11-07T00:15:00.000Z");
        const edited = yield* service.upsert({
          ...running,
          expectedRevision: running.revision,
          title: "Renamed review",
        });
        assert.equal(edited.lastRunStatus, "running");
        const completed = yield* waitForCompletion(service, schedule).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(completed);
        const saved = (yield* service.list({ projectId })).schedules[0]!;
        assert.equal(saved.title, "Renamed review");
        assert.equal(saved.lastRunStatus, "succeeded");
        assert.equal(saved.runCount, 1);
        const suggestions = (yield* f.monarch.list({ projectId })).suggestions;
        assert.equal(suggestions.length, 1);
        assert.deepEqual(suggestions[0]!.targets, [{ targetId, revision: 1 }]);
        assert.deepEqual(suggestions[0]!.modelSelection, modelSelection);
        assert.deepEqual(suggestions[0]!.sourceThreadIds, [ThreadId.make("completed-source")]);
        assert.equal(
          (yield* service.history(schedule)).runs[0]!.suggestionIds[0],
          suggestions[0]!.id,
        );
        assert.equal(
          (yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
          1,
        );
        yield* service.setEnabled({ ...saved, expectedRevision: saved.revision, enabled: false });
      }).pipe(Effect.provide(f.layer));
      // Reconstruct the service using the same database; configuration and history survive.
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        const saved = (yield* service.list({ projectId })).schedules[0]!;
        assert.equal(saved.enabled, false);
        assert.equal(saved.nextRunAt, null);
        assert.equal((yield* service.history(saved)).runs.length, 1);
        const resumed = yield* service.setEnabled({
          ...saved,
          expectedRevision: saved.revision,
          enabled: true,
        });
        assert.equal(resumed.nextRunAt, "2026-11-07T00:15:00.000Z");
        assert.equal(
          (yield* service.upsert({ ...saved, expectedRevision: saved.revision }).pipe(Effect.flip))
            .reason,
          "conflict",
        );
        yield* service.remove({ ...resumed, expectedRevision: resumed.revision });
        assert.deepEqual((yield* service.list({ projectId })).schedules, []);
        assert.equal((yield* service.history(resumed)).runs.length, 1);
        assert.equal((yield* service.runNow(resumed).pipe(Effect.flip)).reason, "not_found");
      }).pipe(Effect.provide(Layer.fresh(f.layer)));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "records generation failure and expired claims without replay or partial suggestions",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let targetId = "";
      let changedTargetId = "";
      const f = yield* fixture(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return {
            suggestions: [
              {
                title: "First",
                prompt: "First valid suggestion",
                rationale: "Supported",
                targetIds: [targetId],
                sourceThreadIds: [],
              },
              {
                title: "Second",
                prompt: "Second valid suggestion",
                rationale: "Supported",
                targetIds: [changedTargetId],
                sourceThreadIds: [],
              },
            ],
          };
        }),
      );
      targetId = f.target.id;
      const changedTarget = yield* f.monarch.createTarget({
        projectId,
        title: "Validate inputs",
        description: "Reject invalid inputs.",
        indicators: [],
        constraints: [],
        status: "active",
      });
      changedTargetId = changedTarget.id;
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        const schedule = yield* create(service);
        yield* service.runNow(schedule);
        yield* Deferred.await(entered);
        // Evidence became stale while inference ran. No generated draft may be committed.
        yield* f.monarch.updateTarget({
          ...changedTarget,
          expectedRevision: 1,
          description: "Changed direction",
        });
        const completion = yield* waitForCompletion(service, schedule).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(completion);
        assert.equal((yield* service.history(schedule)).runs[0]!.status, "failed");
        assert.deepEqual((yield* f.monarch.list({ projectId })).suggestions, []);
        const run: MonarchScheduleRun = {
          id: "review-run:crashed",
          scheduleId: schedule.id,
          projectId,
          trigger: "scheduled",
          scheduledFor: at,
          startedAt: at,
          completedAt: null,
          status: "running",
          error: null,
          modelSelection,
          suggestionIds: [],
        };
        yield* f.sql`INSERT INTO monarch_review_runs (id, schedule_id, project_id, status, started_at, lease_until, payload_json)
      VALUES (${run.id}, ${run.scheduleId}, ${projectId}, 'running', ${at}, ${at}, ${yield* encodeRun(run)})`;
        yield* f.sql`UPDATE monarch_review_schedules SET active_run_id = ${run.id} WHERE id = ${schedule.id}`;
        yield* f.tick;
        const recovered = (yield* service.history(schedule)).runs.find(
          (entry) => entry.id === run.id,
        )!;
        assert.equal(recovered.status, "interrupted");
        assert.isNotNull(recovered.completedAt);
        yield* f.tick;
        assert.equal((yield* service.history(schedule)).runs.length, 2);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it("follows stored timezone across DST and advances weekly and elapsed intervals", () => {
  assert.equal(
    MonarchScheduler.nextMonarchReviewAt(
      { type: "daily", timeOfDay: "09:00" },
      "Europe/Berlin",
      "2026-03-28T08:00:00.000Z",
    ),
    "2026-03-29T07:00:00.000Z",
  );
  assert.equal(
    MonarchScheduler.nextMonarchReviewAt(
      { type: "daily", timeOfDay: "09:00" },
      "Europe/Berlin",
      "2026-10-24T07:00:00.000Z",
    ),
    "2026-10-25T08:00:00.000Z",
  );
  assert.equal(
    MonarchScheduler.nextMonarchReviewAt(
      { type: "weekly", timeOfDay: "09:00", weekday: 1 },
      "Europe/Berlin",
      at,
    ),
    "2026-11-09T08:00:00.000Z",
  );
  assert.equal(
    MonarchScheduler.nextMonarchReviewAt(
      { type: "interval", everyMinutes: 60 },
      "Europe/Berlin",
      "2026-10-25T00:30:00.000Z",
    ),
    "2026-10-25T01:30:00.000Z",
  );
});

it.effect("limits simultaneous inference and does not resurrect dismissed suggestions", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    let targetId = "";
    const f = yield* fixture(() =>
      Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(calls, (n) => n + 1);
        if (count === 2) yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return {
          suggestions: [
            {
              title: "Document inputs",
              prompt: "Write an input manifest.",
              rationale: "Supports reproducibility.",
              targetIds: [targetId],
              sourceThreadIds: [],
            },
          ],
        };
      }),
    );
    targetId = f.target.id;
    yield* Effect.gen(function* () {
      const service = yield* MonarchScheduler.MonarchScheduler;
      const first = yield* create(service);
      const second = yield* create(service);
      const third = yield* create(service);
      yield* service.runNow(first);
      yield* service.runNow(second);
      yield* Deferred.await(entered);
      assert.equal((yield* service.runNow(third).pipe(Effect.flip)).reason, "busy");
      const waitFirst = yield* waitForCompletion(service, first).pipe(Effect.forkChild);
      const waitSecond = yield* waitForCompletion(service, second).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waitFirst);
      yield* Fiber.join(waitSecond);
      const suggestions = (yield* f.monarch.list({ projectId })).suggestions;
      assert.equal(suggestions.length, 1);
      const suggestion = suggestions[0]!;
      yield* f.monarch.setSuggestionStatus({
        ...suggestion,
        expectedRevision: suggestion.revision,
        status: "dismissed",
      });
      yield* service.runNow(third);
      yield* waitForCompletion(service, third);
      assert.equal((yield* f.monarch.list({ projectId })).suggestions.length, 1);
      assert.equal((yield* f.monarch.list({ projectId })).suggestions[0]!.status, "dismissed");
      assert.deepEqual((yield* service.history(third)).runs[0]!.suggestionIds, []);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base)),
);

it.effect("times out a stuck provider and releases its durable run claim", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const f = yield* fixture(() =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    );
    yield* Effect.gen(function* () {
      const service = yield* MonarchScheduler.MonarchScheduler;
      const schedule = yield* create(service);
      yield* service.runNow(schedule);
      yield* Deferred.await(entered);
      const completion = yield* waitForCompletion(service, schedule).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 minutes");
      yield* Fiber.join(completion);
      assert.equal((yield* service.history(schedule)).runs[0]!.status, "failed");
      const [row] = yield* f.sql<{
        active_run_id: string | null;
      }>`SELECT active_run_id FROM monarch_review_schedules WHERE id = ${schedule.id}`;
      assert.equal(row?.active_run_id, null);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base)),
);
