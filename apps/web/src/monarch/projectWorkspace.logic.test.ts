import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import {
  matchesProjectThreadFilter,
  resolveWorkspaceProjectRef,
  selectProjectThreads,
} from "./projectWorkspace.logic";

describe("project workspace", () => {
  it("keeps equal project and thread IDs in different environments separate and respects hidden lineage", () => {
    const environmentId = EnvironmentId.make("first");
    const projectId = ProjectId.make("project");
    const thread = makeThreadFixture({ environmentId, projectId, id: ThreadId.make("shared") });
    const delegated = makeThreadFixture({
      environmentId,
      projectId,
      id: ThreadId.make("delegated"),
    });
    const hidden = makeThreadFixture({ environmentId, projectId, id: ThreadId.make("hidden") });
    const otherEnvironment = makeThreadFixture({
      ...thread,
      environmentId: EnvironmentId.make("second"),
    });
    const child = makeThreadFixture({
      environmentId,
      projectId,
      id: ThreadId.make("child"),
      lineage: {
        rootThreadId: thread.id,
        parentThreadId: thread.id,
        relationshipToParent: "subagent",
      },
    });
    const archived = makeThreadFixture({
      environmentId,
      projectId,
      id: ThreadId.make("archived"),
      archivedAt: "2026-11-04T09:00:00Z",
    });
    const deleted = makeThreadFixture({
      environmentId,
      projectId,
      id: ThreadId.make("deleted"),
      deletedAt: "2026-11-04T09:00:00Z",
    });
    expect(
      selectProjectThreads(
        [thread, otherEnvironment, child, delegated, hidden, archived, deleted],
        scopeProjectRef(environmentId, projectId),
        new Set([threadKey(scopeThreadRef(environmentId, delegated.id))]),
        new Set([threadKey(scopeThreadRef(environmentId, hidden.id))]),
      ),
    ).toEqual([thread]);
    expect(resolveWorkspaceProjectRef({ environmentId, projectId })).toEqual({
      environmentId,
      projectId,
    });
    expect(resolveWorkspaceProjectRef({ environmentId })).toBeNull();
  });

  it("keeps approvals actionable even during a running turn and treats settled as an explicit state", () => {
    const running = makeThreadFixture({
      runtime: {
        status: "running",
        activeRunId: null,
        lastErrorClass: null,
        lastError: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        updatedAt: "2026-11-04T09:00:00Z",
      },
    });
    const approval = { ...running, hasPendingApprovals: true };
    expect(matchesProjectThreadFilter(running, "working")).toBe(true);
    expect(matchesProjectThreadFilter(approval, "attention")).toBe(true);
    expect(matchesProjectThreadFilter(approval, "working")).toBe(false);
    expect(matchesProjectThreadFilter(makeThreadFixture(), "settled")).toBe(false);
    expect(
      matchesProjectThreadFilter(makeThreadFixture({ settledOverride: "settled" }), "settled"),
    ).toBe(true);
  });
});
