import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MonarchContextEntry,
  MonarchError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MonarchTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as Monarch from "../../../monarch/MonarchService.ts";
import * as MonarchContext from "../../../monarch/MonarchContextService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const ownProject = ProjectId.make("project:planning");
const otherProject = ProjectId.make("project:other");
const threadId = ThreadId.make("thread:planning");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("planning-test"),
  requestNamespace: "planning-session",
  thread: {
    threadId,
    providerSessionId: "planning-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "planning-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "planning-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("context reads stay in the caller's project and branch", () => {
  const projects: string[] = [];
  const contextEntry = (id: string, branch: string | null): MonarchContextEntry => ({
    id,
    projectId: ownProject,
    kind: "architecture",
    title: `Architecture ${id}`,
    body: "Uses a local database.",
    scope: branch === null ? "project" : "branch",
    branch,
    sourceRefs: [{ threadId, runId: null }],
    contradictsEntryIds: [],
    evidence: "reported",
    origin: "agent",
    pinned: false,
    revision: 1,
    contextRevision: 1,
    generationId: null,
    removedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const entries = [
    contextEntry("project-entry", null),
    contextEntry("current-branch-entry", "feature/current"),
    contextEntry("other-branch-entry", "feature/other"),
  ];
  const layer = McpHttpServer.layerMonarchContextToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            ...McpToolAccessTestkit.liveThreadShell(threadId),
            projectId: ownProject,
            branch: "feature/current",
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(MonarchContext.MonarchContextService)({
        get: ({ projectId }) =>
          Effect.sync(() => {
            projects.push(projectId);
            return {
              projectId,
              revision: 3,
              settingsRevision: 1,
              enabledAt: null,
              updatedAt: null,
              settings: {
                enabled: true,
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
              },
              entries,
            };
          }),
        brief: ({ projectId, branch }) =>
          Effect.sync(() => {
            projects.push(projectId);
            return {
              projectId,
              revision: 3,
              text: `Current branch: ${branch}`,
              entryIds: ["project-entry", "current-branch-entry"],
              truncated: false,
            };
          }),
      }),
    ),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const listed = yield* call("monarch_context_entries", { projectId: otherProject });
    expect(listed.structuredContent).toMatchObject({
      revision: 3,
      entries: [{ id: "project-entry" }, { id: "current-branch-entry" }],
      nextCursor: null,
    });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("other-branch-entry");
    const brief = yield* call("monarch_context_brief", {});
    expect(brief.structuredContent).toMatchObject({
      projectId: ownProject,
      text: "Current branch: feature/current",
    });
    expect(projects).toEqual([ownProject, ownProject]);

    const external = yield* call("monarch_context_entries", {}, { ...scope, thread: undefined });
    expect(failure(external)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(Effect.provide(layer));
});
const target: MonarchTarget = {
  id: "target-1",
  projectId: ownProject,
  title: "Ship the release",
  description: "A stable release for customers",
  indicators: ["Release passes acceptance checks"],
  constraints: [],
  status: "active",
  revision: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const fields = {
  title: target.title,
  description: target.description,
  indicators: target.indicators,
  constraints: target.constraints,
  status: target.status,
};
const failure = (result: McpSchema.CallToolResult) => {
  const first = result.content[0];
  return result.isError === true && first?.type === "text" ? JSON.parse(first.text) : undefined;
};

it.effect("planning tools stay in the calling thread's project and require write access", () => {
  const reads: string[] = [];
  const writes: string[] = [];
  const layer = McpHttpServer.layerMonarchToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            ...McpToolAccessTestkit.liveThreadShell(threadId),
            projectId: ownProject,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Monarch.MonarchService)({
        list: ({ projectId }) =>
          Effect.sync(() => {
            reads.push(projectId);
            return { targets: [target], suggestions: [], hasMoreHistory: false };
          }),
        createTarget: (input) =>
          Effect.sync(() => {
            writes.push(input.projectId);
            return { ...target, ...input };
          }),
        updateTarget: (input) =>
          input.expectedRevision === target.revision
            ? Effect.sync(() => {
                writes.push(input.projectId);
                return { ...target, ...input, revision: target.revision + 1 };
              })
            : Effect.fail(new MonarchError({ reason: "conflict" })),
      }),
    ),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope = scope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    expect(
      Exit.isFailure(yield* Effect.exit(call("monarch_plan_read", { projectId: otherProject }))),
    ).toBe(true);
    const read = yield* call("monarch_plan_read", {});
    expect(read.isError).toBe(false);
    expect(read.structuredContent).toMatchObject({ targets: [target] });
    expect(reads).toEqual([ownProject]);

    const readOnly = yield* call(
      "monarch_target_create",
      { ...fields, confirmedByUser: true },
      { ...scope, client: { sessionId: "readonly", label: "Test", access: "read-only" } },
    );
    expect(failure(readOnly)).toMatchObject({ code: "capability_denied" });
    expect(writes).toEqual([]);

    expect(Exit.isFailure(yield* Effect.exit(call("monarch_target_create", fields)))).toBe(true);
    expect(writes).toEqual([]);

    const created = yield* call("monarch_target_create", {
      ...fields,
      confirmedByUser: true,
      projectId: otherProject,
    });
    expect(created.isError).toBe(false);
    expect(writes).toEqual([ownProject]);

    const stale = yield* call("monarch_target_update", {
      ...fields,
      id: target.id,
      expectedRevision: 1,
      confirmedByUser: true,
    });
    expect(failure(stale)).toMatchObject({ code: "invalid_request", message: /Refresh/ });
    expect(writes).toEqual([ownProject]);
  }).pipe(Effect.provide(layer));
});
