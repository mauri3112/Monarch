import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type MonarchTimelineEvent,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { overlayCurrentThreadActivity } from "./projectTimelineCurrentState";

it("quiets only current scoped delegated attention and waits while normal running still animates", () => {
  const projectRef = {
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
  };
  const threadId = ThreadId.make("parent");
  const runId = RunId.make("active-run");
  const event: MonarchTimelineEvent = {
    id: "turn:active-run",
    family: "thread",
    entityKind: "thread",
    entityId: threadId,
    action: "Turn running",
    title: "Parent work",
    detail: "",
    at: "2026-11-06T10:00:00.000Z",
    state: "running",
    parentIds: ["thread:parent:created"],
    threadId,
    runId,
  };
  const shell = {
    ...projectRef,
    id: threadId,
    title: "Parent work",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: {
      status: "running" as const,
      activeRunId: runId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-11-06T10:00:00.000Z",
    },
  };
  const overlay = (
    thread: typeof shell & {
      pendingSubagentRequest?: "approval" | "user_input";
      blockedOnThreadWait?: boolean;
      pendingGuestMessageCount?: number;
    },
  ) => overlayCurrentThreadActivity([event], [thread], projectRef)[0]!;
  for (const request of ["approval", "user_input"] as const) {
    expect(overlay({ ...shell, pendingSubagentRequest: request })).toMatchObject({
      state: "needs-input",
      at: null,
      parentIds: event.parentIds,
      threadId,
    });
  }
  expect(overlay({ ...shell, blockedOnThreadWait: true })).toMatchObject({
    state: "recorded",
    action: "Waiting on delegated work",
    at: null,
  });
  expect(overlay({ ...shell, pendingGuestMessageCount: 1 }).state).toBe("needs-input");
  expect(overlay(shell)).toBe(event);
  const completed = { ...event, id: "turn:completed", state: "finished" as const };
  const otherRun = { ...event, id: "turn:older", runId: "older-run" };
  const withParentAttention = overlayCurrentThreadActivity(
    [completed, otherRun],
    [{ ...shell, pendingSubagentRequest: "approval" }],
    projectRef,
  );
  expect(withParentAttention.slice(0, 2)).toEqual([completed, otherRun]);
  expect(withParentAttention[2]).toMatchObject({
    state: "needs-input",
    at: null,
    parentIds: [],
    threadId,
  });
  expect(
    overlay({
      ...shell,
      environmentId: EnvironmentId.make("elsewhere"),
      pendingSubagentRequest: "approval",
    }),
  ).toBe(event);
});
