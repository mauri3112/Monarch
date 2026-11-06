import { assert, it } from "@effect/vitest";
import {
  MonarchScheduleRun,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  TextGenerationError,
  type MonarchScheduleIdentity,
} from "@t3tools/contracts";
import { DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION } from "@t3tools/shared/monarchContext";
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
import * as MonarchContextService from "./MonarchContextService.ts";

const projectId = ProjectId.make("review-fixture");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const at = "2026-11-05T00:00:00.000Z";
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(MonarchScheduleRun));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const base = Layer.mergeAll(MonarchService.layer, MonarchContextService.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
  Layer.provideMerge(Digest.layerWebCrypto),
);

const fixture = Effect.fn("MonarchSchedulerTest.fixture")(function* (
  invoke: NonNullable<ProviderTextGeneration["generateProjectSuggestions"]>,
  extract: NonNullable<ProviderTextGeneration["generateProjectContext"]> = () =>
    Effect.succeed({ entries: [] }),
) {
  yield* TestClock.setTime(Date.parse(at));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Synthetic project', '/tmp/monarch-review-fixture', '[]', ${at}, ${at})`;
  const monarch = yield* MonarchService.MonarchService;
  const context = yield* MonarchContextService.MonarchContextService;
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
        textGeneration: { generateProjectSuggestions: invoke, generateProjectContext: extract },
        snapshot: {
          getSnapshot: Effect.succeed({
            driver: "codex",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              { slug: "test-model" },
              {
                slug: "gpt-6-luna",
                capabilities: {
                  optionDescriptors: [
                    { id: "reasoningEffort", type: "select", options: [{ id: "xhigh" }] },
                  ],
                },
              },
            ],
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
  return { sql, monarch, context, target, layer, tick };
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

const completedEvidence = Effect.fn("MonarchSchedulerTest.completedEvidence")(function* (
  suffix: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = ThreadId.make(`source-${suffix}`);
  const runId = RunId.make(`run-${suffix}`);
  const payload = yield* encodeJson({
    id: runId,
    status: "completed",
    workspacePreparation: { branch: "feature", worktreePath: "/tmp/monarch-review-fixture" },
  });
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
    VALUES(${threadId},${projectId},${suffix},'codex','approval-required','default',${at},${at},'{"branch":"feature"}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
    VALUES(${runId},${threadId},1,'codex','completed',${at},${at},${payload})`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json)
    VALUES(${`message-${suffix}`},${threadId},${runId},'assistant',0,${at},${at},${yield* encodeJson({ text: `Reported implementation outcome ${suffix}. Tests are not independently verified.` })})`;
  yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
    VALUES(${`event-${suffix}`},'thread',${threadId},0,'run.updated',${at},'system',${payload},'{}',2)`;
  return { threadId, runId };
});

const waitForActivity = (service: MonarchScheduler.MonarchScheduler["Service"], count: number) =>
  service.watchActivity({ projectId }).pipe(
    Stream.filter(
      (state) => state.runs.length >= count && state.runs.every((run) => run.status !== "running"),
    ),
    Stream.runHead,
  );

it.effect(
  "reacts once to persisted work and Target revisions, defers active work, and applies context before suggestions",
  () =>
    Effect.gen(function* () {
      const extracts = yield* Ref.make(0);
      const suggestions = yield* Ref.make(0);
      let targetId = "";
      let source: { threadId: ThreadId; runId: RunId } | undefined;
      const f = yield* fixture(
        (input) =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(suggestions, (n) => n + 1);
            if (count === 2) {
              assert.notInclude(
                input.context,
                "An implementation was reported on the feature branch.",
              );
              return { suggestions: [] };
            }
            if (count === 3) {
              const supplied = JSON.parse(input.context) as {
                completedTurnJournals: Array<{ runId: string }>;
              };
              assert.deepEqual(
                supplied.completedTurnJournals.map((j) => j.runId),
                [source!.runId],
              );
              assert.notInclude(
                input.context,
                "An implementation was reported on the feature branch.",
              );
              return { suggestions: [] };
            }
            assert.deepEqual(input.modelSelection, modelSelection);
            assert.include(input.context, "Captured branch outcome");
            assert.notInclude(input.context, "Reported implementation outcome");
            assert.notInclude(input.context, "before-opt-in");
            return {
              suggestions: [
                {
                  title: "Verify branch outcome",
                  prompt: "Verify the reported branch implementation.",
                  rationale: "The branch work remains reported.",
                  targetIds: [targetId],
                  sourceThreadIds: [source!.threadId],
                },
              ],
            };
          }),
        (input) =>
          Effect.gen(function* () {
            assert.deepEqual(input.modelSelection, DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION);
            assert.include(input.context, "Reported implementation outcome");
            const count = yield* Ref.updateAndGet(extracts, (n) => n + 1);
            assert.notInclude(input.context, "Other branch private detail");
            return {
              entries: [
                {
                  kind: "outcome" as const,
                  title: count === 1 ? "Captured branch outcome" : "Follow-up outcome",
                  body:
                    count === 1
                      ? "An implementation was reported on the feature branch."
                      : "The follow-up turn recorded a different outcome.",
                  scope: "branch" as const,
                  branch: "feature",
                  sourceRefs: [source!],
                  contradictsEntryIds: [],
                },
              ],
            };
          }),
      );
      targetId = f.target.id;
      yield* completedEvidence("before-opt-in");
      const initial = yield* f.context.get({ projectId });
      yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: { ...initial.settings, enabled: true, modelSelection },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* f.tick;
        assert.equal(yield* Ref.get(extracts), 0);
        yield* f.context.upsertEntry({
          projectId,
          kind: "decision",
          scope: "branch",
          branch: "elsewhere",
          title: "Private branch note",
          body: "Other branch private detail",
          sourceRefs: [],
          contradictsEntryIds: [],
          pinned: false,
          evidence: "reported",
        });
        source = yield* completedEvidence("after-opt-in");
        const deleted = yield* completedEvidence("deleted-cohort");
        const active = yield* completedEvidence("active-cohort");
        yield* f.sql`UPDATE orchestration_v2_projection_runs SET status='running' WHERE run_id=${active.runId}`;
        yield* f.tick;
        assert.equal((yield* service.activity({ projectId })).blockedReason, "active-work");
        assert.equal(yield* Ref.get(extracts), 0);
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${at} WHERE thread_id=${deleted.threadId}`;
        yield* f.sql`UPDATE orchestration_v2_projection_runs SET status='cancelled' WHERE run_id=${active.runId}`;
        yield* f.tick;
        yield* waitForActivity(service, 1);
        assert.equal(yield* Ref.get(extracts), 1);
        assert.equal(yield* Ref.get(suggestions), 1);
        const activity = yield* service.activity({ projectId });
        assert.equal(activity.runs[0]!.trigger, "work-completed");
        assert.equal(activity.runs[0]!.contextEntryIds?.length, 1);
        const [journal] = yield* f.sql<{
          branch: string;
          worktree_path: string;
          revision: number;
          entries_json: string;
        }>`SELECT branch,worktree_path,revision,entries_json FROM monarch_run_journals WHERE project_id=${projectId} AND run_id=${source.runId}`;
        assert.equal(journal?.branch, "feature");
        assert.equal(journal?.worktree_path, "/tmp/monarch-review-fixture");
        assert.equal(journal?.revision, 1);
        assert.notInclude(journal!.entries_json, "Reported implementation outcome");
        const [review] = yield* f.sql<{
          source_refs_json: string;
        }>`SELECT source_refs_json FROM monarch_review_stages WHERE review_run_id=${activity.runs[0]!.id} AND stage='suggestions'`;
        assert.deepEqual(JSON.parse(review!.source_refs_json), [
          { runId: source.runId, revision: 1 },
        ]);
        assert.equal(
          (yield* f.context.get({ projectId })).entries.find(
            (entry) => entry.title === "Captured branch outcome",
          )!.evidence,
          "reported",
        );
        yield* f.tick;
        assert.equal(yield* Ref.get(extracts), 1);
        assert.equal((yield* service.activity({ projectId })).runs.length, 1);
        yield* f.sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
          SELECT 'redelivered-completion','thread',${source.threadId},1,'run.updated',${at},'system',payload_json,'{}',2
          FROM orchestration_v2_projection_runs WHERE run_id=${source.runId}`;
        yield* f.tick;
        assert.equal((yield* service.activity({ projectId })).runs.length, 1);
        yield* f.monarch.updateTarget({
          ...f.target,
          expectedRevision: f.target.revision,
          description: "A revised active direction.",
        });
        yield* f.tick;
        yield* waitForActivity(service, 2);
        assert.equal(yield* Ref.get(extracts), 1);
        assert.equal(yield* Ref.get(suggestions), 2);
        const original = (yield* f.context.get({ projectId })).entries.find(
          (e) => e.title === "Captured branch outcome",
        )!;
        yield* f.context.removeEntry({
          projectId,
          entryId: original.id,
          expectedRevision: original.revision,
        });
        source = { ...source, runId: RunId.make("second-source-turn") };
        yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
          SELECT ${source.runId},thread_id,2,provider,status,requested_at,completed_at,json_set(payload_json,'$.id',${source.runId})
          FROM orchestration_v2_projection_runs WHERE run_id='run-after-opt-in'`;
        yield* f.sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json)
          VALUES('next-message',${source.threadId},${source.runId},'assistant',0,${at},${at},'{"text":"Reported implementation outcome for the follow-up turn."}')`;
        yield* f.sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
          SELECT 'next-completed-turn','thread',thread_id,2,'run.updated',${at},'system',payload_json,'{}',2 FROM orchestration_v2_projection_runs WHERE run_id=${source.runId}`;
        yield* f.tick;
        yield* waitForActivity(service, 3);
        assert.equal(
          (yield* f.sql`SELECT run_id FROM monarch_run_journals WHERE thread_id=${source.threadId}`)
            .length,
          2,
        );
      }).pipe(Effect.provide(f.layer));
      yield* Effect.gen(function* () {
        yield* f.tick;
        assert.equal(yield* Ref.get(extracts), 2);
        assert.equal(yield* Ref.get(suggestions), 3);
      }).pipe(Effect.provide(Layer.fresh(f.layer)));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "allows explicit context-only builds while automatic updates are off and enforces pause and daily limits",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const f = yield* fixture(
        () => Effect.die("Context-only builds must not generate suggestions"),
        () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ entries: [] })),
      );
      const source = yield* completedEvidence("manual-build");
      const initial = yield* f.context.get({ projectId });
      let state = yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: { ...initial.settings, maxUpdatesPerDay: 1, paused: true },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* service.refresh({ projectId, mode: "build-context", threadIds: [source!.threadId] });
        yield* f.tick;
        assert.equal(yield* Ref.get(calls), 0);
        assert.equal((yield* service.activity({ projectId })).blockedReason, "paused");
        state = yield* f.context.updateSettings({
          projectId,
          expectedRevision: state.revision,
          settings: { ...state.settings, paused: false },
        });
        yield* f.tick;
        yield* waitForActivity(service, 1);
        assert.equal(yield* Ref.get(calls), 1);
        assert.equal((yield* service.activity({ projectId })).runs[0]!.trigger, "build-context");
        assert.deepEqual((yield* service.list({ projectId })).schedules, []);
        const [receipt] = yield* f.sql<{
          entries_json: string;
        }>`SELECT entries_json FROM monarch_run_journals WHERE project_id=${projectId} AND run_id=${source.runId}`;
        assert.equal(receipt?.entries_json, "[]");
        yield* service.refresh({ projectId, mode: "retry" });
        yield* f.tick;
        assert.equal((yield* service.activity({ projectId })).blockedReason, "daily-limit");
        assert.equal((yield* service.activity({ projectId })).updatesToday, 1);
        yield* TestClock.adjust("1 day");
        yield* f.tick;
        yield* waitForActivity(service, 2);
        assert.equal(yield* Ref.get(calls), 1);
        assert.equal((yield* service.activity({ projectId })).pending, false);
        const unsupported = {
          ...modelSelection,
          options: [{ id: "reasoningEffort", value: "unadvertised" }],
        };
        state = yield* f.context.updateSettings({
          projectId,
          expectedRevision: state.settingsRevision,
          settings: { ...state.settings, maxUpdatesPerDay: 10, journalModelSelection: unsupported },
        });
        yield* service.refresh({
          projectId,
          mode: "build-context",
          threadIds: [source.threadId],
          reanalyze: true,
        });
        yield* f.tick;
        yield* waitForActivity(service, 3);
        const [blocked] = yield* f.sql<{
          status: string;
          error: string;
        }>`SELECT status,error FROM monarch_review_stages WHERE project_id=${projectId} AND model_json=${yield* encodeJson(unsupported)}`;
        assert.equal(blocked?.status, "failed");
        assert.include(blocked!.error, "available journal model");
        assert.equal(yield* Ref.get(calls), 1);
        yield* f.context.updateSettings({
          projectId,
          expectedRevision: state.settingsRevision,
          settings: { ...state.settings, journalModelSelection: modelSelection },
        });
        yield* service.refresh({ projectId, mode: "retry" });
        yield* f.tick;
        yield* waitForActivity(service, 4);
        const revisions = yield* f.sql<{
          revision: number;
          model: string;
        }>`SELECT revision,json_extract(model_json,'$.model') AS model FROM monarch_run_journal_revisions WHERE project_id=${projectId} AND run_id=${source.runId} ORDER BY revision`;
        assert.deepEqual(
          revisions.map((row) => [row.revision, row.model]),
          [
            [1, "gpt-6-luna"],
            [2, "test-model"],
          ],
        );
        assert.equal(yield* Ref.get(calls), 2);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "preserves combined Target/work causes and does not loop over sources excluded after queueing",
  () =>
    Effect.gen(function* () {
      const captures = yield* Ref.make(0);
      const suggestions = yield* Ref.make(0);
      const f = yield* fixture(
        () => Ref.update(suggestions, (n) => n + 1).pipe(Effect.as({ suggestions: [] })),
        () => Ref.update(captures, (n) => n + 1).pipe(Effect.as({ entries: [] })),
      );
      const initial = yield* f.context.get({ projectId });
      let state = yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: {
          ...initial.settings,
          enabled: true,
          modelSelection,
          paused: true,
          suggestAfterWork: false,
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* f.tick;
        const evidence = yield* completedEvidence("excluded-after-queue");
        yield* f.monarch.updateTarget({
          ...f.target,
          expectedRevision: 1,
          title: "Changed target",
        });
        yield* f.tick;
        assert.equal((yield* service.activity({ projectId })).pending, true);
        state = yield* f.context.updateSettings({
          projectId,
          expectedRevision: state.revision,
          settings: { ...state.settings, paused: false, excludedThreadIds: [evidence.threadId] },
        });
        yield* f.tick;
        yield* waitForActivity(service, 1);
        assert.equal(yield* Ref.get(captures), 0);
        assert.equal(yield* Ref.get(suggestions), 1);
        assert.equal((yield* service.activity({ projectId })).runs[0]!.trigger, "project-changed");
        yield* f.tick;
        assert.equal((yield* service.activity({ projectId })).runs.length, 1);
        assert.equal((yield* service.activity({ projectId })).pending, false);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "retains applied context and its activity provenance when suggestions fail, then retries without recapturing",
  () =>
    Effect.gen(function* () {
      const extracts = yield* Ref.make(0);
      const attempts = yield* Ref.make(0);
      let source: { threadId: ThreadId; runId: RunId } | undefined;
      const f = yield* fixture(
        (input) =>
          Effect.gen(function* () {
            assert.include(input.context, "Reported storage change");
            const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
            if (attempt === 1)
              return yield* new TextGenerationError({
                operation: "test",
                detail: "Synthetic provider failure",
              });
            return { suggestions: [] };
          }),
        (input) =>
          input.context.includes("run-separate-branch")
            ? Ref.update(extracts, (n) => n + 1).pipe(Effect.as({ entries: [] }))
            : Ref.update(extracts, (n) => n + 1).pipe(
                Effect.as({
                  entries: [
                    {
                      kind: "outcome" as const,
                      title: "Reported storage change",
                      body: "Storage changed on the branch; no independent checks recorded.",
                      scope: "branch" as const,
                      branch: "feature",
                      sourceRefs: [source!],
                      contradictsEntryIds: [],
                    },
                  ],
                }),
              ),
      );
      source = yield* completedEvidence("partial-context");
      const initial = yield* f.context.get({ projectId });
      yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: { ...initial.settings, modelSelection },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* service.refresh({ projectId, mode: "build-context", threadIds: [source!.threadId] });
        yield* service.refresh({ projectId, mode: "refresh" });
        yield* f.tick;
        yield* waitForActivity(service, 1);
        const failed = yield* service.activity({ projectId });
        assert.equal(failed.blockedReason, "failed");
        assert.equal(failed.runs[0]!.status, "failed");
        assert.equal(failed.runs[0]!.contextEntryIds?.length, 1);
        assert.equal((yield* f.context.get({ projectId })).entries.length, 1);
        yield* f.tick;
        assert.equal(yield* Ref.get(attempts), 1);
        const other = yield* completedEvidence("separate-branch");
        yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.workspacePreparation.branch','unrelated') WHERE run_id=${other.runId}`;
        yield* service.refresh({ projectId, mode: "build-context", threadIds: [other.threadId] });
        yield* service.refresh({ projectId, mode: "retry" });
        yield* f.tick;
        yield* waitForActivity(service, 2);
        assert.equal(yield* Ref.get(extracts), 1);
        assert.equal(yield* Ref.get(attempts), 2);
        const completed = yield* service.activity({ projectId });
        assert.equal(completed.pending, true);
        const retry = completed.runs.find((run) => run.trigger === "retry")!;
        assert.equal(retry.retryOfRunId, failed.runs[0]!.id);
        assert.equal(retry.reviewScopeRunId, source!.runId);
        assert.deepEqual(retry.sourceRunIds, []);
        yield* f.tick;
        yield* waitForActivity(service, 3);
        assert.equal(yield* Ref.get(extracts), 2);
        assert.equal(yield* Ref.get(attempts), 2);
        assert.equal((yield* service.activity({ projectId })).pending, false);
        assert.equal(completed.updatesToday, 2);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "rejects context extraction across a Target revision and leaves its evidence available for explicit retry",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let source: { threadId: ThreadId; runId: RunId } | undefined;
      const f = yield* fixture(
        () => Effect.die("Build context must not suggest"),
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return {
              entries: [
                {
                  kind: "outcome" as const,
                  title: "A captured result",
                  body: "A reported feature-branch outcome.",
                  scope: "branch" as const,
                  branch: "feature",
                  sourceRefs: [source!],
                  contradictsEntryIds: [],
                },
              ],
            };
          }),
      );
      source = yield* completedEvidence("stale-target");
      const initial = yield* f.context.get({ projectId });
      yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: { ...initial.settings, modelSelection },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* service.refresh({ projectId, mode: "build-context", threadIds: [source!.threadId] });
        yield* f.tick;
        yield* Deferred.await(entered);
        yield* f.monarch.updateTarget({
          ...f.target,
          expectedRevision: f.target.revision,
          description: "New direction during inference.",
        });
        yield* Deferred.succeed(release, undefined);
        yield* waitForActivity(service, 1);
        assert.deepEqual((yield* f.context.get({ projectId })).entries, []);
        assert.equal((yield* service.activity({ projectId })).runs[0]!.status, "failed");
        assert.equal(
          (yield* f.sql<{
            captured: number;
          }>`SELECT captured FROM monarch_continuity_sources WHERE run_id=${source!.runId}`)[0]
            ?.captured,
          0,
        );
        yield* service.refresh({ projectId, mode: "retry" });
        yield* f.tick;
        yield* waitForActivity(service, 2);
        assert.equal((yield* f.context.get({ projectId })).entries.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "pausing during suggestion inference prevents stale suggestions from being committed",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let targetId = "";
      const f = yield* fixture(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return {
            suggestions: [
              {
                title: "A proposed next step",
                prompt: "Inspect the current implementation before changing it.",
                rationale: "Supports the active Target.",
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
        const schedule = yield* create(service);
        yield* service.runNow(schedule);
        yield* Deferred.await(entered);
        const current = yield* f.context.get({ projectId });
        const paused = yield* f.context.updateSettings({
          projectId,
          expectedRevision: current.revision,
          settings: { ...current.settings, paused: true },
        });
        yield* Deferred.succeed(release, undefined);
        yield* waitForCompletion(service, schedule);
        assert.deepEqual((yield* f.monarch.list({ projectId })).suggestions, []);
        assert.equal((yield* service.history(schedule)).runs[0]!.status, "failed");
        assert.equal((yield* service.runNow(schedule).pipe(Effect.flip)).reason, "paused");
        yield* f.context.updateSettings({
          projectId,
          expectedRevision: paused.revision,
          settings: { ...paused.settings, paused: false },
        });
        yield* service.runNow(schedule);
        yield* waitForCompletion(service, schedule);
        assert.equal((yield* f.monarch.list({ projectId })).suggestions.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "retires an entire suggestion-only backlog atomically while preserving later arrivals and explicit builds",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const capturedInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const f = yield* fixture(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { suggestions: [] };
          }),
        (input) =>
          Ref.update(capturedInputs, (inputs) => [...inputs, input.context]).pipe(
            Effect.as({ entries: [] }),
          ),
      );
      const initial = yield* f.context.get({ projectId });
      let state = yield* f.context.updateSettings({
        projectId,
        expectedRevision: initial.revision,
        settings: { ...initial.settings, enabled: true, modelSelection, autoUpdateContext: false },
      });
      yield* Effect.gen(function* () {
        const service = yield* MonarchScheduler.MonarchScheduler;
        yield* f.tick;
        for (let index = 0; index < 25; index++)
          yield* completedEvidence(`ignored-${String(index).padStart(2, "0")}`);
        yield* f.tick;
        yield* Deferred.await(entered);
        assert.equal(
          (yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM monarch_continuity_sources WHERE project_id=${projectId} AND captured=2`)[0]
            ?.count,
          25,
        );
        const late = yield* completedEvidence("later-arrival");
        yield* f.tick;
        assert.equal(
          (yield* f.sql<{
            captured: number;
          }>`SELECT captured FROM monarch_continuity_sources WHERE run_id=${late.runId}`)[0]
            ?.captured,
          0,
        );
        yield* Deferred.succeed(release, undefined);
        yield* waitForActivity(service, 1);
        yield* f.tick;
        yield* waitForActivity(service, 2);
        assert.equal(
          (yield* f.sql<{
            captured: number;
          }>`SELECT captured FROM monarch_continuity_sources WHERE run_id=${late.runId}`)[0]
            ?.captured,
          2,
        );
        state = yield* f.context.updateSettings({
          projectId,
          expectedRevision: state.revision,
          settings: { ...state.settings, autoUpdateContext: true },
        });
        yield* completedEvidence("new-capture");
        yield* f.tick;
        yield* waitForActivity(service, 3);
        const inputs = yield* Ref.get(capturedInputs);
        assert.equal(inputs.length, 1);
        assert.include(inputs[0]!, "new-capture");
        assert.notInclude(inputs[0]!, "ignored-");
        assert.notInclude(inputs[0]!, "later-arrival");
        yield* service.refresh({ projectId, mode: "build-context", threadIds: [late.threadId] });
        yield* f.tick;
        yield* waitForActivity(service, 4);
        assert.equal((yield* Ref.get(capturedInputs)).length, 2);
        assert.equal(
          (yield* f.sql<{
            captured: number;
          }>`SELECT captured FROM monarch_continuity_sources WHERE run_id=${late.runId}`)[0]
            ?.captured,
          1,
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(base)),
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
        VALUES ('completed-run', 'completed-source', 1, 'codex', 'completed', ${at}, ${at}, '{"workspacePreparation":{"branch":"feature"}}')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('reply', 'completed-source', 'completed-run', 'assistant', 0, ${at}, ${at}, '{"text":"Ingestion exists but its input manifest remains undocumented."}')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('hidden', 'completed-source', 'completed-run', 'system', 0, ${at}, ${at}, '{"text":"SYSTEM_CONTEXT_MUST_STAY_PRIVATE"}')`;
      yield* f.sql`INSERT INTO monarch_run_journals(project_id,run_id,thread_id,completed_at,branch,entries_json,review_run_id,model_json,started_at,recorded_at)
      VALUES(${projectId},'completed-run','completed-source',${at},NULL,${yield* encodeJson([{ kind: "outcome", title: "Known inputs", body: "A saved journal describes the missing manifest.", scope: "project", branch: null, sourceRefs: [{ threadId: "completed-source", runId: "completed-run" }], contradictsEntryIds: [] }])},'old-review','{}',${at},${at})`;
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
        assert.include(context, "A saved journal describes the missing manifest");
        assert.notInclude(context, "input manifest remains undocumented");
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
        if (count === 1) yield* Deferred.succeed(entered, undefined);
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
      assert.equal((yield* service.runNow(second).pipe(Effect.flip)).reason, "busy");
      yield* Deferred.await(entered);
      assert.equal((yield* service.runNow(third).pipe(Effect.flip)).reason, "busy");
      const waitFirst = yield* waitForCompletion(service, first).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waitFirst);
      yield* service.runNow(second);
      yield* waitForCompletion(service, second);
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
      yield* TestClock.adjust("8 minutes");
      yield* Fiber.join(completion);
      assert.equal((yield* service.history(schedule)).runs[0]!.status, "failed");
      const [row] = yield* f.sql<{
        active_run_id: string | null;
      }>`SELECT active_run_id FROM monarch_review_schedules WHERE id = ${schedule.id}`;
      assert.equal(row?.active_run_id, null);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(base)),
);
