import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { MonarchTimelineEvent, ScopedProjectRef } from "@t3tools/contracts";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";

type CurrentThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "title"
  | "environmentId"
  | "projectId"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "blockedOnThreadWait"
>;

/** Current shell attention can quiet active work without rewriting completed history. */
export function overlayCurrentThreadActivity(
  events: readonly MonarchTimelineEvent[],
  threads: readonly CurrentThread[],
  projectRef: ScopedProjectRef,
): readonly MonarchTimelineEvent[] {
  const visibleThreads = new Set(
    events.filter((event) => event.entityKind === "thread").map((event) => event.entityId),
  );
  const currentThreads = new Map(
    threads
      .filter(
        (thread) =>
          visibleThreads.has(thread.id) &&
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      )
      .map((thread) => [thread.id, thread]),
  );
  const overlaid = events.map<MonarchTimelineEvent>((event) => {
    if (
      event.family !== "thread" ||
      event.entityKind !== "thread" ||
      event.state !== "running" ||
      !event.threadId ||
      !event.runId
    )
      return event;
    const thread = currentThreads.get(event.threadId);
    if (!thread || thread.id !== event.entityId || thread.runtime?.activeRunId !== event.runId)
      return event;
    const status = resolveSidebarThreadStatus(thread);
    switch (status) {
      case "approval":
      case "input":
      case "request":
        return {
          ...event,
          state: "needs-input",
          action:
            status === "approval"
              ? "Approval needed"
              : status === "input"
                ? "Input needed"
                : "Guest request waiting",
          detail: thread.pendingSubagentRequest
            ? "Delegated work needs your response. Open the thread to inspect the request."
            : status === "request"
              ? "A guest is waiting for a response in this thread."
              : event.detail,
          // The shell reports current state, not when a delegated request began.
          at: null,
        };
      case "waiting":
        return {
          ...event,
          state: "recorded",
          action: thread.blockedOnThreadWait ? "Waiting on delegated work" : "Waiting",
          detail: thread.blockedOnThreadWait
            ? "Waiting on child work. Open the thread to inspect its progress."
            : "The thread is waiting.",
          at: null,
        };
      default:
        return event;
    }
  });
  for (const thread of currentThreads.values()) {
    const status = resolveSidebarThreadStatus(thread);
    const needsResponse = status === "approval" || status === "input" || status === "request";
    const waiting = status === "waiting" && thread.blockedOnThreadWait === true;
    if (
      (!needsResponse && !waiting) ||
      overlaid.some(
        (event) =>
          event.entityKind === "thread" &&
          event.entityId === thread.id &&
          (event.state === "needs-input" ||
            (event.at === null && event.action === "Waiting on delegated work")),
      )
    )
      continue;
    // Derived parent attention may outlive its completed turn. It has no recorded
    // start or causal child edge, so keep the saved turn intact and add a snapshot.
    overlaid.push({
      id: `current-thread:${JSON.stringify([projectRef.environmentId, projectRef.projectId, thread.id])}`,
      family: "thread",
      entityKind: "thread",
      entityId: thread.id,
      title: thread.title,
      state: needsResponse ? "needs-input" : "recorded",
      at: null,
      action:
        status === "approval"
          ? "Approval needed"
          : status === "input"
            ? "Input needed"
            : status === "request"
              ? "Guest request waiting"
              : "Waiting on delegated work",
      detail: waiting
        ? "Waiting on child work. Open the thread to inspect its progress."
        : "Current work needs your response. Open the thread to inspect the request.",
      parentIds: [],
      threadId: thread.id,
      runId: thread.runtime?.activeRunId ?? null,
    });
  }
  return overlaid;
}
