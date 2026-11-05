import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ThreadId,
  type MonarchTarget,
  type NextThreadSuggestion,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MonarchService from "./MonarchService.ts";

const fixture = Effect.fn("fixture")(function* (suffix: string) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectId = ProjectId.make(`planning-${suffix}`);
  const at = "2026-11-05T00:00:00.000Z";
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make(`project-${suffix}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Synthetic project",
      workspaceRoot: `/tmp/monarch-fixture-${suffix}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const service = yield* MonarchService.MonarchService;
  const target = yield* service.createTarget({
    projectId,
    title: "Keep research reproducible",
    description: "Another researcher can repeat the analysis.",
    indicators: ["Documented inputs"],
    constraints: ["No private data in examples"],
    status: "active",
  });
  return { service, projectId, target };
});
const createSuggestion = (
  service: MonarchService.MonarchService["Service"],
  target: MonarchTarget,
  dedupeKey?: string,
) =>
  service.createSuggestion({
    projectId: target.projectId,
    title: "Document analysis inputs",
    prompt: "Inspect the data ingestion and propose a reproducible input manifest.",
    rationale: "Supports documented inputs.",
    targets: [{ targetId: target.id, revision: target.revision }],
    sourceThreadIds: [],
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
  });
const input = (suggestion: NextThreadSuggestion) => ({
  projectId: suggestion.projectId,
  id: suggestion.id,
  expectedRevision: suggestion.revision,
});
const insertThread = Effect.fn("insertThread")(function* (
  projectId: ProjectId,
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, ${projectId}, 'Synthetic thread', 'codex', 'full-access', 'default', '2026-11-05', '2026-11-05', '{}')`;
});
const testLayer = Layer.merge(MonarchService.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

it.layer(testLayer)("Monarch planning", (it) => {
  it.effect(
    "persists multiple directions, lifecycle changes and revision conflicts across service instances",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("persistence");
        yield* service.createTarget({
          projectId,
          title: "Improve handoff",
          description: "",
          indicators: [],
          constraints: [],
          status: "draft",
        });
        let current = target;
        for (const status of ["paused", "active", "achieved", "archived", "active"] as const) {
          current = yield* service.updateTarget({
            ...current,
            expectedRevision: current.revision,
            status,
          });
          assert.strictEqual(current.status, status);
        }
        const stale = yield* service
          .updateTarget({ ...target, expectedRevision: target.revision, title: "Stale edit" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        if (Result.isFailure(stale)) assert.strictEqual(stale.failure.reason, "conflict");
        const reloaded = yield* Effect.gen(function* () {
          return yield* (yield* MonarchService.MonarchService).list({ projectId });
        }).pipe(Effect.provide(Layer.fresh(MonarchService.layer)));
        assert.strictEqual(reloaded.targets.length, 2);
        assert.deepStrictEqual(
          reloaded.targets.find((value) => value.id === target.id),
          current,
        );
        const sql = yield* SqlClient.SqlClient;
        const persisted = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM monarch_targets WHERE id = ${target.id}`;
        assert.strictEqual(JSON.parse(persisted[0]!.payload).revision, current.revision);
      }),
  );

  it.effect("rejects cross-project item, target and thread references and deleted projects", () =>
    Effect.gen(function* () {
      const first = yield* fixture("scope-a");
      const second = yield* fixture("scope-b");
      const foreignThread = ThreadId.make("foreign-evidence");
      yield* insertThread(second.projectId, foreignThread);
      const suggestion = yield* createSuggestion(first.service, first.target);
      const failures = yield* Effect.all([
        first.service
          .updateTarget({ ...first.target, projectId: second.projectId, expectedRevision: 1 })
          .pipe(Effect.result),
        first.service
          .createSuggestion({ ...suggestion, projectId: second.projectId })
          .pipe(Effect.result),
        first.service
          .createSuggestion({ ...suggestion, sourceThreadIds: [foreignThread] })
          .pipe(Effect.result),
        first.service
          .prepareSuggestion({ ...input(suggestion), projectId: second.projectId })
          .pipe(Effect.result),
      ]);
      assert.deepStrictEqual(
        failures.map((result) => (result._tag === "Failure" ? result.failure.reason : "success")),
        ["not_found", "invalid_reference", "invalid_reference", "not_found"],
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-11-05' WHERE project_id = ${first.projectId}`;
      const deleted = yield* first.service.list({ projectId: first.projectId }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(deleted));
      if (Result.isFailure(deleted)) assert.strictEqual(deleted.failure.reason, "not_found");
    }),
  );

  it.effect(
    "keeps review suggestions idempotent, editable and reversible without creating a thread",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("suggestions");
        const suggestion = yield* createSuggestion(service, target, "run-1:0");
        const duplicates = yield* Effect.all(
          [
            createSuggestion(service, target, "run-1:0"),
            createSuggestion(service, target, "run-1:0"),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(duplicates, [suggestion, suggestion]);
        const edited = yield* service.updateSuggestion({
          ...input(suggestion),
          title: "Review manifest",
          prompt: "Write a manifest proposal first.",
        });
        const removed = yield* service.setSuggestionStatus({
          ...input(edited),
          status: "dismissed",
        });
        const cannotUse = yield* service.prepareSuggestion(input(removed)).pipe(Effect.result);
        assert.isTrue(Result.isFailure(cannotUse));
        const restored = yield* service.setSuggestionStatus({
          ...input(removed),
          status: "suggested",
        });
        const prepared = yield* service.prepareSuggestion(input(restored));
        assert.isNotNull(prepared.draftThreadId);
        assert.deepStrictEqual(yield* service.prepareSuggestion(input(prepared)), prepared);
        assert.strictEqual(prepared.prompt, edited.prompt);
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM orchestration_v2_projection_threads WHERE project_id = ${projectId}`;
        assert.strictEqual(threads[0]?.count, 0);
        const unpersisted = yield* service
          .markSuggestionUsed({ ...input(prepared), threadId: prepared.draftThreadId! })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(unpersisted));
        if (Result.isFailure(unpersisted))
          assert.strictEqual(unpersisted.failure.reason, "invalid_reference");
      }),
  );

  it.effect(
    "does not notify or persist a nested suggestion when the review transaction rolls back",
    () =>
      Effect.gen(function* () {
        let notifications = 0;
        const sql = yield* SqlClient.SqlClient;
        const observedSql = Object.assign((...args: Parameters<typeof sql>) => sql(...args), sql, {
          afterCommit: (effect: Effect.Effect<void>) =>
            sql.afterCommit(
              effect.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    notifications += 1;
                  }),
                ),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const { service, projectId, target } = yield* fixture("rollback-notification");
          const sql = yield* SqlClient.SqlClient;
          notifications = 0;
          const aborted = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* createSuggestion(service, target);
                assert.strictEqual(notifications, 0);
                return yield* Effect.fail("abort review");
              }),
            )
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(aborted));
          assert.strictEqual(notifications, 0);
          assert.deepStrictEqual((yield* service.list({ projectId })).suggestions, []);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* createSuggestion(service, target);
              assert.strictEqual(notifications, 0);
            }),
          );
          assert.strictEqual(notifications, 1);
          assert.strictEqual((yield* service.list({ projectId })).suggestions.length, 1);
        }).pipe(
          Effect.provide(Layer.fresh(MonarchService.layer)),
          Effect.provideService(SqlClient.SqlClient, observedSql),
        );
      }),
  );

  it.effect(
    "keeps all active suggestions visible and bounds creation and restore independently of history",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("capacity");
        const suggestion = yield* createSuggestion(service, target);
        const sql = yield* SqlClient.SqlClient;
        // Seed boundary-sized history without making the behavior test perform hundreds of UI mutations.
        yield* sql`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 199)
      INSERT INTO monarch_suggestions(id, project_id, revision, payload_json)
      SELECT 'active-' || n, project_id, 1, json_set(payload_json, '$.id', 'active-' || n)
      FROM sequence CROSS JOIN monarch_suggestions WHERE id = ${suggestion.id}`;
        yield* sql`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 101)
      INSERT INTO monarch_suggestions(id, project_id, revision, payload_json)
      SELECT 'history-' || n, project_id, 1, json_set(payload_json, '$.id', 'history-' || n, '$.status', 'dismissed', '$.updatedAt', '2099-01-01')
      FROM sequence CROSS JOIN monarch_suggestions WHERE id = ${suggestion.id}`;
        const state = yield* service.list({ projectId });
        assert.strictEqual(
          state.suggestions.filter((value) => value.status === "suggested").length,
          200,
        );
        assert.strictEqual(
          state.suggestions.filter((value) => value.status !== "suggested").length,
          100,
        );
        assert.isTrue(state.hasMoreHistory);
        const create = yield* createSuggestion(service, target).pipe(Effect.result);
        assert.isTrue(Result.isFailure(create));
        if (Result.isFailure(create)) assert.strictEqual(create.failure.reason, "capacity");
        const restoreInput = {
          projectId,
          id: "history-1",
          expectedRevision: 1,
          status: "suggested",
        } as const;
        const restore = yield* service.setSuggestionStatus(restoreInput).pipe(Effect.result);
        assert.isTrue(Result.isFailure(restore));
        if (Result.isFailure(restore)) assert.strictEqual(restore.failure.reason, "capacity");
        yield* service.setSuggestionStatus({ ...input(suggestion), status: "dismissed" });
        assert.strictEqual((yield* service.setSuggestionStatus(restoreInput)).status, "suggested");
      }),
  );

  it.effect("streams a committed project change after its initial persisted snapshot", () =>
    Effect.gen(function* () {
      const { service, projectId, target } = yield* fixture("watch");
      const initialRead = yield* Deferred.make<void>();
      const fiber = yield* service.watch({ projectId }).pipe(
        Stream.tap(() => Deferred.succeed(initialRead, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(initialRead);
      const revised = yield* service.updateTarget({
        ...target,
        expectedRevision: target.revision,
        status: "paused",
      });
      const snapshots = yield* Fiber.join(fiber);
      assert.strictEqual(snapshots.length, 2);
      assert.deepStrictEqual(snapshots[0]?.targets, [target]);
      assert.deepStrictEqual(snapshots[1]?.targets, [revised]);
    }),
  );

  it.effect(
    "blocks stale target references until explicitly rebased and recovers used links after lost acknowledgement",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("stale");
        const suggestion = yield* createSuggestion(service, target);
        const revised = yield* service.updateTarget({
          ...target,
          title: "Reproducible research",
          expectedRevision: target.revision,
        });
        const stale = yield* service.prepareSuggestion(input(suggestion)).pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        if (Result.isFailure(stale)) assert.strictEqual(stale.failure.reason, "conflict");
        const rebased = yield* service.updateSuggestion({
          ...input(suggestion),
          title: suggestion.title,
          prompt: suggestion.prompt,
          targets: [{ targetId: revised.id, revision: revised.revision }],
        });
        const prepared = yield* service.prepareSuggestion(input(rebased));
        yield* service.updateTarget({
          ...revised,
          expectedRevision: revised.revision,
          status: "paused",
        });
        yield* insertThread(projectId, prepared.draftThreadId!);
        const reloaded = yield* service.list({ projectId });
        const used = reloaded.suggestions[0]!;
        assert.strictEqual(used.status, "used");
        assert.strictEqual(used.usedThreadId, prepared.draftThreadId);
        assert.deepStrictEqual(
          yield* service.markSuggestionUsed({
            ...input(prepared),
            threadId: prepared.draftThreadId!,
          }),
          used,
        );
        const removal = yield* service
          .setSuggestionStatus({ ...input(used), status: "dismissed" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(removal));
        if (Result.isFailure(removal)) assert.strictEqual(removal.failure.reason, "invalid_state");
      }),
  );
});
