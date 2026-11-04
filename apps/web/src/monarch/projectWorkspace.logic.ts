import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

import {
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadStatus,
} from "../components/Sidebar.logic";

export type ProjectThreadFilter = "all" | "attention" | "working" | "settled";

export function resolveWorkspaceProjectRef(
  params: Partial<Record<"environmentId" | "projectId", string>>,
): ScopedProjectRef | null {
  return params.environmentId && params.projectId
    ? scopeProjectRef(params.environmentId as EnvironmentId, params.projectId as ProjectId)
    : null;
}

export function selectProjectThreads(
  threads: readonly EnvironmentThreadShell[],
  projectRef: ScopedProjectRef,
  delegatedUnderParent: ReadonlySet<string>,
  hiddenThreadKeys: ReadonlySet<string>,
): EnvironmentThreadShell[] {
  const scoped = threads.filter(
    (thread) =>
      thread.environmentId === projectRef.environmentId &&
      thread.projectId === projectRef.projectId &&
      thread.deletedAt === null &&
      !hiddenThreadKeys.has(
        threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
  );
  return filterSidebarV2VisibleThreads(scoped, null, delegatedUnderParent).sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
}

export function matchesProjectThreadFilter(
  thread: EnvironmentThreadShell,
  filter: ProjectThreadFilter,
): boolean {
  const status = resolveSidebarThreadStatus(thread);
  switch (filter) {
    case "attention":
      return ["approval", "input", "request", "limited", "failed"].includes(status);
    case "working":
      return status === "working" || status === "waiting";
    case "settled":
      return thread.settledOverride === "settled";
    case "all":
      return true;
  }
}
