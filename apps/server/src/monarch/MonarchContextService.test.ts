import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type MonarchContextEntry,
  type MonarchGeneratedContextEntry,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MonarchContextService from "./MonarchContextService.ts";

const fixture = Effect.fn("ContextTest.fixture")(function* (
  key: string,
  branch: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* MonarchContextService.MonarchContextService;
  const projectId = ProjectId.make(`context-${key}`);
  const threadId = ThreadId.make(`thread-${key}`);
  const runId = RunId.make(`run-${key}`);
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Synthetic project', '/tmp/monarch-context-fixture', '[]', '2026-11-05', '2026-11-05')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, ${projectId}, 'Synthetic implementation', 'codex', 'full-access', 'default', '2026-11-05', '2026-11-05', json_object('branch', ${branch}))`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
    VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', '2026-11-05', '2026-11-05', '{}')`;
  yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES (${`created-${key}`}, 'thread', ${threadId}, 1, 'thread.created', '2026-11-05', 'system', json_object('branch', ${branch}, 'worktreePath', NULL), '{}', 2)`;
  yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES (${`run-created-${key}`}, 'thread', ${threadId}, 2, 'run.created', '2026-11-05', 'system', json_object('id', ${runId}), '{}', 2)`;
  const entry: MonarchGeneratedContextEntry = {
    kind: "architecture",
    title: "Local project store",
    body: "The implementation uses SQLite for local state.",
    scope: branch === null ? "project" : "branch",
    branch,
    sourceRefs: [{ threadId, runId }],
    contradictsEntryIds: [],
  };
  return { service, projectId, threadId, runId, entry, sql };
});
const identity = (entry: MonarchContextEntry) => ({
  projectId: entry.projectId,
  entryId: entry.id,
  expectedRevision: entry.revision,
});
const base = MonarchContextService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

it.layer(base)("Project context", (it) => {
  it.effect(
    "defaults to no automatic inference and persists user settings with independent settings revisions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("settings");
        const initial = yield* f.service.get({ projectId: f.projectId });
        assert.isFalse(initial.settings.enabled);
        assert.isNull(initial.settings.modelSelection);
        assert.strictEqual(initial.revision, 0);
        const [eventWatermark] = yield* f.sql<{
          sequence: number;
        }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`;
        const noModel = yield* f.service
          .updateSettings({
            projectId: f.projectId,
            expectedRevision: 0,
            settings: { ...initial.settings, enabled: true },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(noModel));
        const state = yield* f.service.updateSettings({
          projectId: f.projectId,
          expectedRevision: 0,
          settings: {
            ...initial.settings,
            enabled: true,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "synthetic-model",
            },
            brief: "Keep the project local and understandable.",
          },
        });
        assert.isNotNull(state.enabledAt);
        assert.strictEqual(state.settingsRevision, 1);
        const [row] = yield* f.sql<{
          enabled_sequence: number;
          enabled_target_fingerprint: string;
        }>`SELECT enabled_sequence, enabled_target_fingerprint FROM monarch_project_context WHERE project_id = ${f.projectId}`;
        assert.strictEqual(row?.enabled_sequence, eventWatermark?.sequence);
        assert.strictEqual(row?.enabled_target_fingerprint, "[]");
        yield* f.service.upsertEntry({
          projectId: f.projectId,
          ...f.entry,
          evidence: "confirmed",
          pinned: true,
        });
        const paused = yield* f.service.updateSettings({
          projectId: f.projectId,
          expectedRevision: state.settingsRevision,
          settings: { ...state.settings, paused: true },
        });
        assert.strictEqual(paused.enabledAt, state.enabledAt);
        const reloaded = yield* Effect.gen(function* () {
          return yield* (yield* MonarchContextService.MonarchContextService).get({
            projectId: f.projectId,
          });
        }).pipe(Effect.provide(Layer.fresh(MonarchContextService.layer)));
        assert.deepStrictEqual(reloaded, paused);
        const stale = yield* f.service
          .updateSettings({ projectId: f.projectId, expectedRevision: 1, settings: state.settings })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        if (Result.isFailure(stale)) assert.strictEqual(stale.failure.reason, "conflict");
      }),
  );

  it.effect(
    "preserves confirmed decisions and records contradictory branch reports without promoting their authority",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("branch", "codex/storage");
        const decision = yield* f.service.upsertEntry({
          projectId: f.projectId,
          ...f.entry,
          kind: "decision",
          title: "Storage policy",
          body: "Use plain files for editable user data.",
          scope: "project",
          branch: null,
          sourceRefs: [],
          evidence: "confirmed",
          pinned: true,
        });
        const state = yield* f.service.get({ projectId: f.projectId });
        const result = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: state.revision,
          generationId: "branch-job",
          entries: [{ ...f.entry, contradictsEntryIds: [decision.id] }],
        });
        assert.deepStrictEqual(
          result.entries.find((entry) => entry.id === decision.id),
          decision,
        );
        const report = result.entries.find((entry) => entry.origin === "agent")!;
        assert.strictEqual(report.evidence, "reported");
        assert.isFalse(report.pinned);
        assert.strictEqual(report.branch, "codex/storage");
        const general = yield* f.service.brief({ projectId: f.projectId });
        assert.deepStrictEqual(general.entryIds, [decision.id]);
        const branch = yield* f.service.brief({ projectId: f.projectId, branch: "codex/storage" });
        assert.include(branch.entryIds, report.id);
        assert.include(branch.text, "Needs confirmation");
        assert.include(branch.text, "reported");
        assert.deepStrictEqual(
          yield* f.service.applyGenerated({
            projectId: f.projectId,
            expectedRevision: state.revision,
            generationId: "branch-job",
            entries: [],
          }),
          result,
        );
        const promoted = yield* f.service
          .applyGenerated({
            projectId: f.projectId,
            expectedRevision: result.revision,
            generationId: "bad-scope",
            entries: [{ ...f.entry, kind: "question", scope: "project", branch: null }],
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(promoted));
        if (Result.isFailure(promoted))
          assert.strictEqual(promoted.failure.reason, "invalid_reference");
        yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_object('workspacePreparation', json_object('type','existing_worktree','worktreePath','/tmp/unknown-worktree')) WHERE run_id = ${f.runId}`;
        const unknownWorktree = yield* f.service
          .sourceScope({ projectId: f.projectId, threadId: f.threadId, runId: f.runId })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(unknownWorktree));
        if (Result.isFailure(unknownWorktree))
          assert.strictEqual(unknownWorktree.failure.reason, "unknown_scope");
      }),
  );

  it.effect("rejects cross-project, incomplete, stale and excluded evidence atomically", () =>
    Effect.gen(function* () {
      const f = yield* fixture("scope");
      const other = yield* fixture("other");
      yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_object('branch', 'later-branch') WHERE thread_id = ${f.threadId}`;
      assert.isNull(
        (yield* f.service.sourceScope({
          projectId: f.projectId,
          threadId: f.threadId,
          runId: f.runId,
        })).branch,
      );
      const wrong = yield* f.service
        .applyGenerated({
          projectId: f.projectId,
          expectedRevision: 0,
          generationId: "cross-project",
          entries: [{ ...f.entry }, { ...other.entry }],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(wrong));
      assert.deepStrictEqual((yield* f.service.get({ projectId: f.projectId })).entries, []);
      yield* f.sql`UPDATE orchestration_v2_projection_runs SET status = 'failed' WHERE run_id = ${f.runId}`;
      const failed = yield* f.service
        .applyGenerated({
          projectId: f.projectId,
          expectedRevision: 0,
          generationId: "failed-run",
          entries: [f.entry],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(failed));
      yield* f.sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = ${f.runId}`;
      const user = yield* f.service.upsertEntry({
        projectId: f.projectId,
        ...f.entry,
        evidence: "confirmed",
        pinned: true,
      });
      const stale = yield* f.service
        .applyGenerated({
          projectId: f.projectId,
          expectedRevision: 0,
          generationId: "stale-job",
          entries: [f.entry],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(stale));
      if (Result.isFailure(stale)) assert.strictEqual(stale.failure.reason, "conflict");
      const before = yield* f.service.get({ projectId: f.projectId });
      const excluded = yield* f.service.updateSettings({
        projectId: f.projectId,
        expectedRevision: before.settingsRevision,
        settings: { ...before.settings, excludedThreadIds: [f.threadId] },
      });
      assert.deepStrictEqual(excluded.entries, []);
      assert.strictEqual((yield* f.service.brief({ projectId: f.projectId })).text, "");
      const restore = yield* f.service.restoreEntry(identity(user)).pipe(Effect.result);
      assert.isTrue(Result.isFailure(restore));
      if (Result.isFailure(restore)) assert.strictEqual(restore.failure.reason, "excluded_source");
      const generated = yield* f.service
        .applyGenerated({
          projectId: f.projectId,
          expectedRevision: excluded.revision,
          generationId: "excluded-job",
          entries: [f.entry],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(generated));
      if (Result.isFailure(generated))
        assert.strictEqual(generated.failure.reason, "excluded_source");
    }),
  );

  it.effect(
    "hides generated transitive quotes of excluded sources while keeping explicit user edits",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("transitive-exclusion");
        const otherThread = ThreadId.make("context-dependent-thread");
        const otherRun = RunId.make("context-dependent-run");
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${otherThread}, ${f.projectId}, 'Independent source', 'codex', 'full-access', 'default', '2026-11-05', '2026-11-05', json_object('branch','main'))`;
        yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES (${otherRun}, ${otherThread}, 1, 'codex', 'completed', '2026-11-05', '2026-11-05', json_object('workspacePreparation',json_object('type','root','branch','main')))`;
        const first = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: 0,
          generationId: "exclusion-a",
          entries: [f.entry],
        });
        const a = first.entries[0]!;
        const proposal: MonarchGeneratedContextEntry = {
          ...f.entry,
          kind: "question",
          title: "Storage discrepancy",
          body: "The prior context says the implementation uses SQLite. The new result contradicts that claim.",
          scope: "branch",
          branch: "main",
          sourceRefs: [{ threadId: otherThread, runId: otherRun }],
          contradictsEntryIds: [a.id],
        };
        const second = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: first.revision,
          generationId: "exclusion-b",
          entries: [proposal],
        });
        const b = second.entries.find((entry) => entry.generationId === "exclusion-b")!;
        const third = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: second.revision,
          generationId: "exclusion-c",
          entries: [
            {
              ...proposal,
              title: "Follow-up discrepancy",
              body: "The SQLite claim quoted by the storage question still needs resolution.",
              contradictsEntryIds: [b.id],
            },
          ],
        });
        const c = third.entries.find((entry) => entry.generationId === "exclusion-c")!;
        const explicit = yield* f.service.upsertEntry({
          projectId: f.projectId,
          ...proposal,
          title: "User storage direction",
          body: "Keep user data local.",
          evidence: "confirmed",
          pinned: true,
        });
        const state = yield* f.service.get({ projectId: f.projectId });
        assert.strictEqual(state.entries.length, 4);
        const excluded = yield* f.service.updateSettings({
          projectId: f.projectId,
          expectedRevision: state.settingsRevision,
          settings: { ...state.settings, excludedThreadIds: [f.threadId] },
        });
        assert.deepStrictEqual(
          excluded.entries.map((entry) => entry.id),
          [explicit.id],
        );
        const brief = yield* f.service.brief({ projectId: f.projectId, branch: "main" });
        assert.deepStrictEqual(brief.entryIds, [explicit.id]);
        assert.notInclude(brief.text, "SQLite");
        const restored = yield* f.service.updateSettings({
          projectId: f.projectId,
          expectedRevision: excluded.settingsRevision,
          settings: { ...excluded.settings, excludedThreadIds: [] },
        });
        assert.sameMembers(
          restored.entries.map((entry) => entry.id),
          [a.id, b.id, c.id, explicit.id],
        );
      }),
  );

  it.effect(
    "keeps correction and removal history, restores a selected revision and suppresses repeated removed material",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("history");
        const captured = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: 0,
          generationId: "capture",
          entries: [f.entry],
        });
        const original = captured.entries[0]!;
        const corrected = yield* f.service.upsertEntry({
          ...original,
          expectedRevision: original.revision,
          body: "SQLite stores metadata only.",
          evidence: "confirmed",
          pinned: true,
        });
        const removed = yield* f.service.removeEntry(identity(corrected));
        assert.deepStrictEqual((yield* f.service.get({ projectId: f.projectId })).entries, []);
        const current = yield* f.service.get({ projectId: f.projectId });
        const repeated = yield* f.service.applyGenerated({
          projectId: f.projectId,
          expectedRevision: current.revision,
          generationId: "repeat-capture",
          entries: [f.entry],
        });
        assert.deepStrictEqual(repeated.entries, []);
        const restored = yield* f.service.restoreEntry({
          ...identity(removed),
          restoreRevision: corrected.revision,
        });
        assert.strictEqual(restored.body, corrected.body);
        assert.strictEqual(restored.evidence, "confirmed");
        const history = yield* f.service.history({ projectId: f.projectId, entryId: original.id });
        assert.deepStrictEqual(
          history.items.map((item) => item.action),
          ["restored", "removed", "updated", "created"],
        );
        assert.strictEqual(history.items.at(-1)?.entry.body, f.entry.body);
        const conflictingEdit = yield* f.service
          .upsertEntry({ ...original, expectedRevision: original.revision })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(conflictingEdit));
      }),
  );

  it.effect("bounds injected context and streams committed changes without launching work", () =>
    Effect.gen(function* () {
      const f = yield* fixture("brief");
      const started = yield* Deferred.make<void>();
      const watcher = yield* f.service.watch({ projectId: f.projectId }).pipe(
        Stream.tap(() => Deferred.succeed(started, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      const initial = yield* f.service.get({ projectId: f.projectId });
      yield* f.service.updateSettings({
        projectId: f.projectId,
        expectedRevision: 0,
        settings: { ...initial.settings, brief: "User direction. ".repeat(500) },
      });
      const snapshots = yield* Fiber.join(watcher);
      assert.strictEqual(snapshots.length, 2);
      assert.strictEqual(snapshots[1]?.settingsRevision, 1);
      yield* f.service.upsertEntry({
        projectId: f.projectId,
        ...f.entry,
        body: "A".repeat(4_000),
        evidence: "reported",
        pinned: false,
      });
      yield* f.service.upsertEntry({
        projectId: f.projectId,
        ...f.entry,
        title: "Other state",
        body: "B".repeat(4_000),
        evidence: "confirmed",
        pinned: true,
      });
      const brief = yield* f.service.brief({ projectId: f.projectId });
      assert.isAtMost(brief.text.length, 12_000);
      assert.isTrue(brief.truncated);
      assert.include(brief.text, "User project brief");
      const [row] = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE project_id = ${f.projectId}`;
      assert.strictEqual(row?.count, 1);
    }),
  );
});
