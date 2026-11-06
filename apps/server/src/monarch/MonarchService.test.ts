import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  RunId,
  ThreadId,
  type MonarchTarget,
  type NextThreadSuggestion,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MonarchService from "./MonarchService.ts";
import * as MonarchContextService from "./MonarchContextService.ts";

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
  contextRevision?: number,
) =>
  service.createSuggestion({
    projectId: target.projectId,
    title: "Document analysis inputs",
    prompt: "Inspect the data ingestion and propose a reproducible input manifest.",
    rationale: "Supports documented inputs.",
    targets: [{ targetId: target.id, revision: target.revision }],
    sourceThreadIds: [],
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    ...(contextRevision === undefined ? {} : { contextRevision }),
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
const testLayer = Layer.mergeAll(
  MonarchService.layer,
  MonarchContextService.layer,
  ProjectStore.layer,
).pipe(
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
        const timeline = yield* service.timeline({ projectId });
        assert.deepEqual(
          timeline.events.filter((e) => e.entityId === target.id).map((e) => e.action),
          [
            "Target added",
            "Target paused",
            "Target restored",
            "Target achieved",
            "Target archived",
            "Target restored",
          ],
        );
      }),
  );

  it.effect(
    "pages same-time events, locates an older item and clears answered input within the project",
    () =>
      Effect.gen(function* () {
        const { projectId, service, target } = yield* fixture("timeline");
        const other = yield* fixture("timeline-foreign");
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("timeline-source");
        yield* insertThread(projectId, thread);
        const foreign = ThreadId.make("other-timeline-source");
        yield* insertThread(other.projectId, foreign);
        for (let index = 0; index < 90; index++) {
          yield* service.createTarget({
            projectId,
            title: `Target ${index}`,
            description: "",
            constraints: [],
            indicators: [],
            status: "active",
          });
        }
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
          VALUES('waiting-turn',${thread},1,'codex','running','2026-11-05T08:00:00.000Z','{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
      VALUES ('need',${thread},'node','user_input','pending','2026-11-05T09:00:00.000Z','{}')`;
        const pending = yield* service.timeline({
          projectId,
          focus: { entityKind: "target", entityId: target.id },
        });
        assert.isTrue(pending.hasOlder);
        assert.isFalse(pending.events.some((e) => e.threadId === thread && e.state === "running"));

        assert.isTrue(pending.events.some((e) => e.entityId === target.id));
        assert.isTrue(
          pending.events.some((e) => e.threadId === thread && e.state === "needs-input"),
        );
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved' WHERE runtime_request_id='need'`;
        const cleared = yield* service.timeline({
          projectId,
          focus: { entityKind: "thread", entityId: foreign },
        });
        assert.isFalse(
          cleared.events.some((e) => e.state === "needs-input" || e.threadId === foreign),
        );
        const first = yield* service.timelineHistory({ projectId });
        assert.deepEqual(cleared.nextCursor, first.nextCursor);
        assert.isTrue(cleared.events.some((e) => e.threadId === thread && e.state === "running"));
        const second = yield* service.timelineHistory({ projectId, before: first.nextCursor! });
        const third = yield* service.timelineHistory({ projectId, before: second.nextCursor! });
        assert.equal(first.events.length, 40);
        assert.isFalse(
          second.events.some((past) => cleared.events.some((recent) => recent.id === past.id)),
        );
        assert.isNull(third.nextCursor);
        const ids = [...first.events, ...second.events, ...third.events].map((e) => e.id);
        assert.equal(new Set(ids).size, 92);
        assert.equal(ids.length, 92);
      }),
  );
  it.effect(
    "anchors a historical manual review to its project, and only the known proposal revision to its recorded Target",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("action-links");
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-05T20:42:40.445Z";
        const end = "2026-11-05T20:42:55.793Z";
        yield* sql`INSERT INTO monarch_review_runs(id,schedule_id,project_id,status,started_at,lease_until,payload_json)
      VALUES('manual','managed',${projectId},'succeeded',${at},${end},json_object('trigger','refresh','sourceRunIds',json_array(),'completedAt',${end},'suggestionIds',json_array('proposal')))`;
        const source = ThreadId.make("related-chat");
        yield* insertThread(projectId, source);
        const proposal = {
          id: "proposal",
          projectId,
          revision: 3,
          status: "suggested",
          title: "Candidate",
          prompt: "Saved",
          rationale: "",
          targets: [{ targetId: target.id, revision: target.revision }],
          sourceThreadIds: [source],
          sourceRunId: "manual",
          draftThreadId: "reserved",
          usedThreadId: null,
          createdAt: end,
          updatedAt: "2026-11-06T12:00:00Z",
        };
        yield* sql`INSERT INTO monarch_suggestions(id,project_id,revision,payload_json) VALUES('proposal',${projectId},2,${JSON.stringify({ ...proposal, revision: 2, draftThreadId: null })})`;
        yield* sql`UPDATE monarch_suggestions SET revision=3,payload_json=${JSON.stringify(proposal)} WHERE id='proposal'`;
        yield* sql`DELETE FROM monarch_planning_events WHERE project_id=${projectId} AND kind='suggestion'`;
        yield* sql`DELETE FROM monarch_timeline_history WHERE project_id=${projectId} AND entity_kind='suggestion'`;
        for (const [revision, action, time] of [
          [1, "Thread suggested", end],
          [2, "Latest known revision", "2026-11-05T21:12:31Z"],
          [3, "Draft prepared", "2026-11-06T12:00:00Z"],
        ] as const)
          yield* sql`INSERT INTO monarch_planning_events VALUES(${projectId},'suggestion','proposal',${revision},${time},${action},'Candidate','suggested','manual')`;
        const targetEvent = `target:${target.id}:0000000001`;
        for (const snapshot of [
          yield* service.timeline({ projectId }),
          yield* service.timelineHistory({ projectId }),
        ]) {
          const event = (id: string) => snapshot.events.find((e) => e.id === id)!;
          assert.isTrue(event("review:manual").projectScope);
          assert.deepEqual(event("review:manual").relatedEventIds ?? [], []);
          assert.deepEqual(event("suggestion:proposal:0000000001").parentIds, ["review:manual"]);
          assert.deepEqual(event("suggestion:proposal:0000000001").relatedEventIds, [
            `thread:${source}:created`,
          ]);
          assert.deepEqual(event("suggestion:proposal:0000000002").relatedEventIds, [targetEvent]);
          assert.deepEqual(event("suggestion:proposal:0000000003").relatedEventIds ?? [], []);
        }
        yield* sql`INSERT INTO monarch_project_context(project_id,settings_json) VALUES(${projectId},'{"excludedThreadIds":["related-chat"]}')`;
        yield* TestClock.setTime(Date.parse("2026-11-07T12:00:00.000Z"));
        for (let i = 0; i < 42; i++)
          yield* service.createTarget({
            projectId,
            title: `Later item ${i}`,
            status: "active",
            description: "",
            constraints: [],
            indicators: [],
          });
        assert.isFalse(
          (yield* service.timeline({ projectId })).events.some((event) => event.id === targetEvent),
        );
        const focused = yield* service.timeline({
          projectId,
          focus: {
            entityKind: "suggestion",
            entityId: "proposal",
            eventId: "suggestion:proposal:0000000002",
          },
        });
        assert.isTrue(focused.events.some((event) => event.id === targetEvent));
        assert.isFalse(
          focused.events.some(
            (event) => event.entityKind === "thread" && event.entityId === source,
          ),
        );
        const foreign = yield* fixture("action-links-foreign");
        yield* sql`UPDATE monarch_suggestions SET revision=4,payload_json=json_set(payload_json,'$.revision',4,'$.targets',json_array(json_object('targetId',${foreign.target.id},'revision',1))) WHERE id='proposal'`;
        const hidden = yield* service.timeline({
          projectId,
          focus: { entityKind: "suggestion", entityId: "proposal" },
        });
        assert.isFalse(
          hidden.events.some((e) =>
            e.relatedEventIds?.includes(`target:${foreign.target.id}:0000000001`),
          ),
        );
      }),
  );
  it.effect("retains each saved Target set on the revision that established it", () =>
    Effect.gen(function* () {
      const { service, projectId, target: a } = yield* fixture("proposal-receipts");
      const sql = yield* SqlClient.SqlClient;
      const b = yield* service.createTarget({
        projectId,
        title: "Second target",
        status: "active",
        description: "",
        indicators: [],
        constraints: [],
      });
      const proposal = yield* createSuggestion(service, a);
      const renamed = yield* service.updateSuggestion({
        ...input(proposal),
        title: "Updated wording",
        prompt: proposal.prompt,
      });
      const changed = yield* service.updateSuggestion({
        ...input(renamed),
        title: renamed.title,
        prompt: renamed.prompt,
        targets: [{ targetId: b.id, revision: b.revision }],
      });
      yield* sql`UPDATE monarch_suggestions SET revision=4,payload_json=json_set(payload_json,'$.revision',4,'$.targets',json_array(json_object('targetId',${a.id},'revision',1)))
      WHERE id=${changed.id} AND project_id=${projectId}`;
      yield* sql`UPDATE monarch_suggestions SET revision=5,payload_json=json_set(payload_json,'$.revision',5,'$.title','Edited again') WHERE id=${changed.id} AND project_id=${projectId}`;
      const targetA = `target:${a.id}:0000000001`;
      const targetB = `target:${b.id}:0000000001`;
      for (const snapshot of [
        yield* service.timelineHistory({ projectId }),
        yield* service.timeline({
          projectId,
          focus: { entityKind: "suggestion", entityId: proposal.id },
        }),
      ]) {
        const origins = [1, 2, 3, 4, 5].map(
          (revision) =>
            snapshot.events.find(
              (event) =>
                event.id === `suggestion:${proposal.id}:${String(revision).padStart(10, "0")}`,
            )?.relatedEventIds ?? [],
        );
        assert.deepEqual(origins, [[targetA], [], [targetB], [targetA], []]);
      }
    }),
  );
  it.effect(
    "links only recorded review inputs and prompt recipients that are visible at that time",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("timeline-inputs");
        const sql = yield* SqlClient.SqlClient;
        const source = ThreadId.make("eligible-work");
        const future = ThreadId.make("after-run");
        const sourceAt = "2026-11-05T15:00:00.000Z";
        const actedAt = "2026-11-05T16:00:00.000Z";
        yield* insertThread(projectId, source);
        yield* insertThread(projectId, future);
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES
      ('source',${source},1,'codex','completed',${sourceAt},${sourceAt},'{}'),
      ('too-late',${future},1,'codex','completed',${sourceAt},'2026-11-05T17:00:00.000Z','{}')`;
        yield* sql`INSERT INTO monarch_review_runs(id,schedule_id,project_id,status,started_at,lease_until,payload_json)
      VALUES('claimed','managed',${projectId},'running',${actedAt},${actedAt},'{"trigger":"refresh","sourceRunIds":["source","too-late"]}')`;
        yield* sql`INSERT INTO monarch_prompt_runs(project_id,task_id,started_at,completed_at,status,title,thread_id)
      VALUES(${projectId},'prompt',${actedAt},${actedAt},'succeeded','Continue work',${source})`;
        yield* sql`INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,
      model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count)
      VALUES('bound','Bound','Continue',1,'{"type":"interval"}',${projectId},${source},'{}','{}','approval-required','default','user','web',${actedAt},${actedAt},'2026-11-06T16:00:00.000Z','never',0),
      ('project','Project','Start',1,'{"type":"interval"}',${projectId},NULL,'{}','{}','approval-required','default','user','web',${actedAt},${actedAt},'2026-11-06T16:00:00.000Z','never',0)`;
        const suggestion = yield* createSuggestion(service, target);
        const snap = yield* service.timeline({ projectId });
        const event = (id: string) => snap.events.find((e) => e.id === id)!;
        assert.deepEqual(event(`suggestion:${suggestion.id}:0000000001`).relatedEventIds, [
          `target:${target.id}:0000000001`,
        ]);
        assert.deepEqual(event("review:claimed").relatedEventIds, ["turn:source"]);
        assert.isUndefined(event("review:claimed").projectScope);
        assert.deepEqual(event(`prompt:prompt:${actedAt}`).relatedEventIds, [
          `thread:${source}:created`,
        ]);
        assert.deepEqual(
          event("next:prompt-schedule:bound:2026-11-06T16:00:00.000Z").relatedEventIds,
          [`thread:${source}:created`],
        );
        assert.deepEqual(event("schedule:prompt-schedule:bound").relatedEventIds, [
          `thread:${source}:created`,
        ]);
        assert.isTrue(event("schedule:prompt-schedule:project").projectScope);
        yield* sql`UPDATE scheduled_tasks SET updated_at='2026-11-06T12:00:00.000Z',next_run_at='2026-11-07T12:00:00.000Z' WHERE task_id IN ('bound','project')`;
        const afterTick = yield* service.timelineHistory({ projectId });
        assert.deepEqual(
          afterTick.events.find((e) => e.id === "schedule:prompt-schedule:bound")?.relatedEventIds,
          [`thread:${source}:created`],
        );
        assert.isTrue(
          afterTick.events.find((e) => e.id === "schedule:prompt-schedule:project")?.projectScope,
        );

        yield* sql`INSERT INTO monarch_project_context(project_id,settings_json) VALUES(${projectId},'{"excludedThreadIds":["eligible-work"]}')`;
        const scoped = yield* service.timeline({ projectId });
        for (const id of [
          "review:claimed",
          `prompt:prompt:${actedAt}`,
          "schedule:prompt-schedule:bound",
        ]) {
          const item = scoped.events.find((e) => e.id === id)!;
          assert.isUndefined(item.relatedEventIds);
          assert.isUndefined(item.projectScope);
        }
        yield* sql`UPDATE scheduled_tasks SET thread_id=NULL,updated_at='2026-11-06T13:00:00.000Z' WHERE task_id='bound'`;
        const changed = yield* service.timeline({ projectId });
        assert.isUndefined(
          changed.events.find((e) => e.id === "schedule:prompt-schedule:bound")?.projectScope,
        );
      }),
  );
  it.effect("retains both settled occurrences around a manual reopen", () =>
    Effect.gen(function* () {
      const { projectId, service } = yield* fixture("reopen");
      const sql = yield* SqlClient.SqlClient;
      const thread = ThreadId.make("repeated-settle");
      yield* insertThread(projectId, thread);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"settledAt":"2026-11-05T01:00:00Z","settledOverride":"settled"}' WHERE thread_id=${thread}`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"unsettledAt":"2026-11-05T02:00:00Z","settledOverride":"active"}' WHERE thread_id=${thread}`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"settledAt":"2026-11-05T03:00:00Z","settledOverride":"settled"}' WHERE thread_id=${thread}`;
      const history = yield* service.timelineHistory({ projectId });
      const settled = history.events.filter((e) => e.action === "Thread settled");
      assert.equal(settled.length, 2);
      assert.notEqual(settled[0]!.id, settled[1]!.id);
      assert.isTrue(history.events.some((e) => e.action === "Thread reopened"));
      const current = yield* service.timeline({ projectId });
      assert.isTrue(current.events.some((e) => e.id === settled[1]!.id));
    }),
  );
  it.effect(
    "opens the recorded journal revision and its supplied source even after a later reanalysis",
    () =>
      Effect.gen(function* () {
        const { projectId, service } = yield* fixture("timeline-journals");
        const sql = yield* SqlClient.SqlClient;
        const source = ThreadId.make("journal-source");
        yield* insertThread(projectId, source);
        const at = "2026-11-05T09:00:00.000Z";
        const model = '{"provider":"codex","model":"luna","options":{"reasoningEffort":"xhigh"}}';
        const entries =
          '[{"title":"Choice","body":"Keep the original decision.","kind":"decision","scope":"project","branch":null,"sourceRefs":[{"threadId":"journal-source","runId":"source-run"}],"contradictsEntryIds":[]}]';
        yield* sql`INSERT INTO monarch_run_journals(project_id,run_id,thread_id,completed_at,entries_json,review_run_id,model_json,started_at,recorded_at)
      VALUES(${projectId},'source-run',${source},${at},${entries},'first-review',${model},${at},${at})`;
        yield* sql`UPDATE monarch_run_journals SET revision=2,entries_json='[]',review_run_id='second-review' WHERE project_id=${projectId}`;
        yield* sql`INSERT INTO monarch_review_stages(project_id,review_run_id,stage,source_run_ids_json,source_refs_json,model_json,started_at,completed_at,status)
      VALUES(${projectId},'review','suggestions','["source-run"]','[{"runId":"source-run","revision":1}]',${model},${at},${at},'succeeded')`;
        yield* sql`INSERT INTO monarch_review_stages(project_id,review_run_id,stage,source_run_ids_json,model_json,started_at,completed_at,status)
          VALUES(${projectId},'first-review','journal','["source-run"]',${model},${at},${at},'succeeded')`;
        const first = { projectId, runId: RunId.make("source-run"), revision: 1 };
        const receipt = (yield* service.journal(first)).journal!;
        assert.equal(receipt.entries[0]?.body, "Keep the original decision.");
        assert.equal(receipt.threadId, source);
        assert.deepEqual(receipt.modelSelection.options, [
          { id: "reasoningEffort", value: "xhigh" },
        ]);
        assert.deepEqual((yield* service.journal({ ...first, revision: 2 })).journal?.entries, []);
        assert.isNull((yield* service.journal({ ...first, revision: 3 })).journal);
        const foreign = yield* fixture("foreign-journal");
        assert.isNull((yield* service.journal({ ...first, projectId: foreign.projectId })).journal);
        const input = {
          projectId,
          focus: {
            entityKind: "journal" as const,
            entityId: "source-run",
            eventId: "journal:source-run:1",
          },
        };
        const timeline = yield* service.timeline(input);
        const old = timeline.events.find((e) => e.id === input.focus.eventId)!;
        assert.include(old.detail, "Keep the original decision.");
        assert.include(old.detail, "xhigh");
        assert.equal(old.threadId, source);
        const stage = timeline.events.find((e) => e.id === "stage:review:suggestions")!;
        const ref = { runId: first.runId, revision: 1 };
        assert.deepEqual(old.relatedEventIds, ["turn:source-run"]);
        assert.deepEqual(stage.relatedEventIds, ["turn:source-run"]);
        assert.deepEqual(old.journalRefs, [ref]);
        assert.deepEqual(stage.journalRefs, [ref]);
        assert.strictEqual(stage.modelStage, "suggestions");
        assert.strictEqual(
          timeline.events.find((e) => e.id === "stage:first-review:journal")?.modelStage,
          "journal",
        );
        assert.deepEqual(
          timeline.events.find((e) => e.id === "stage:first-review:journal")?.journalRefs,
          [ref],
        );
        assert.include(stage.parentIds, old.id);
        assert.notInclude(stage.parentIds, "journal:source-run:2");
        const opened = yield* Deferred.make<void>();
        const subscription = yield* service.watchJournal(first).pipe(
          Stream.tap(() => Deferred.succeed(opened, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(opened);
        yield* sql`INSERT INTO monarch_project_context(project_id,settings_json) VALUES(${projectId},'{"excludedThreadIds":["journal-source"]}')`;
        yield* TestClock.adjust("3 seconds");
        const updates = yield* Fiber.join(subscription);
        assert.deepEqual(
          updates.map((u) => u.journal?.revision ?? null),
          [1, null],
        );
        assert.isNull((yield* service.journal(first)).journal);
        assert.notEqual(
          (yield* service.timelineHistory({ projectId })).visibilityKey,
          timeline.visibilityKey,
        );

        assert.isFalse(
          (yield* service.timeline(input)).events.some(
            (e) =>
              e.entityKind === "journal" ||
              e.parentIds.includes(old.id) ||
              e.journalRefs?.some((link) => link.runId === first.runId),
          ),
        );
        assert.isFalse(
          (yield* service.timelineHistory({ projectId })).events.some(
            (e) => e.entityKind === "journal",
          ),
        );
        yield* sql`UPDATE monarch_project_context SET settings_json='{"excludedThreadIds":[]}' WHERE project_id=${projectId}`;
        yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${projectId}`;
        assert.isNull((yield* service.journal(first)).journal);
        yield* sql`UPDATE projection_projects SET deleted_at=NULL WHERE project_id=${projectId}`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${at} WHERE thread_id=${source}`;
        assert.isNull((yield* service.journal(first)).journal);
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
        assert.isFalse(state.suggestions.some((item) => item.id === "history-1"));
        const focused = yield* service.list({ projectId, focusSuggestionId: "history-1" });
        assert.deepEqual(
          focused.suggestions.map((item) => item.id),
          [...state.suggestions.map((item) => item.id), "history-1"],
        );
        assert.isFalse(focused.hasMoreHistory);
        const visible = yield* service.list({ projectId, focusSuggestionId: suggestion.id });
        assert.deepEqual(visible, state);
        const foreign = yield* fixture("foreign-suggestion-focus");
        const outside = yield* createSuggestion(foreign.service, foreign.target);
        assert.deepEqual(yield* service.list({ projectId, focusSuggestionId: outside.id }), state);
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
      const timelineReady = yield* Deferred.make<void>();
      const timelineFiber = yield* service.watchTimeline({ projectId }).pipe(
        Stream.tap(() => Deferred.succeed(timelineReady, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(timelineReady);
      yield* Deferred.await(initialRead);
      const revised = yield* service.updateTarget({
        ...target,
        expectedRevision: target.revision,
        status: "paused",
      });
      yield* TestClock.adjust("3 seconds");
      const timelineSnapshots = yield* Fiber.join(timelineFiber);
      assert.isTrue(timelineSnapshots[1]!.events.some((e) => e.action === "Target paused"));
      const snapshots = yield* Fiber.join(fiber);
      assert.strictEqual(snapshots.length, 2);
      assert.deepStrictEqual(snapshots[0]?.targets, [target]);
      assert.deepStrictEqual(snapshots[1]?.targets, [revised]);
    }),
  );

  it.effect(
    "blocks stale target and context references until explicitly reviewed and recovers used links after lost acknowledgement",
    () =>
      Effect.gen(function* () {
        const { service, projectId, target } = yield* fixture("stale");
        const context = yield* MonarchContextService.MonarchContextService;
        const initial = yield* context.get({ projectId });
        const contextState = yield* context.updateSettings({
          projectId,
          expectedRevision: 0,
          settings: { ...initial.settings, brief: "Keep research reproducible." },
        });
        const suggestion = yield* createSuggestion(
          service,
          target,
          undefined,
          contextState.revision,
        );
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
        const changedContext = yield* context.updateSettings({
          projectId,
          expectedRevision: contextState.settingsRevision,
          settings: {
            ...contextState.settings,
            brief: "Require explicit provenance for each data input.",
          },
        });
        const staleContext = yield* service.prepareSuggestion(input(prepared)).pipe(Effect.result);
        assert.isTrue(Result.isFailure(staleContext));
        if (Result.isFailure(staleContext))
          assert.strictEqual(staleContext.failure.reason, "conflict");
        const staleGeneration = yield* service
          .createSuggestion({ ...suggestion, targets: rebased.targets })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(staleGeneration));
        if (Result.isFailure(staleGeneration))
          assert.strictEqual(staleGeneration.failure.reason, "conflict");
        const reviewed = yield* service.updateSuggestion({
          ...input(prepared),
          title: prepared.title,
          prompt: prepared.prompt,
          contextRevision: changedContext.revision,
        });
        const continued = yield* service.prepareSuggestion(input(reviewed));
        assert.strictEqual(continued.draftThreadId, prepared.draftThreadId);
        assert.strictEqual(continued.prompt, prepared.prompt);
        yield* service.updateTarget({
          ...revised,
          expectedRevision: revised.revision,
          status: "paused",
        });
        yield* insertThread(projectId, prepared.draftThreadId!);
        assert.equal((yield* service.list({ projectId })).suggestions[0]?.status, "suggested");
        const timeline = yield* service.timeline({ projectId });
        assert.isFalse(
          timeline.events.some(
            (e) =>
              e.threadId === prepared.draftThreadId &&
              e.parentIds.some((id) => id.startsWith("suggestion:")),
          ),
        );
        const premature = yield* service
          .markSuggestionUsed({ ...input(continued), threadId: prepared.draftThreadId! })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(premature));
        const database = yield* SqlClient.SqlClient;
        yield* database`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
          VALUES ('sent',${prepared.draftThreadId},'user',0,'2026-11-05','2026-11-05','{"createdBy":"user"}')`;
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
