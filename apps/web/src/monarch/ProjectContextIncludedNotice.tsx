import type { ScopedProjectRef } from "@t3tools/contracts";
import { boundedProjectContextSnapshot } from "@t3tools/shared/monarchContext";
import { BookOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";
import { useMonarchDock } from "./MonarchDockContext";
import { MonarchPanelShell } from "./MonarchPanelShell";

/** The bounded provider context prepared for the next message in this branch. */
export function ProjectContextIncludedNotice({
  projectRef,
  branch,
  panelOnly = false,
  onClose,
  dockEnabled = true,
}: {
  projectRef: ScopedProjectRef;
  branch?: string | null;
  panelOnly?: boolean;
  onClose?: () => void;
  dockEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const workspaceDock = useMonarchDock();
  const dock = dockEnabled ? workspaceDock : null;
  const activeDockKind = dock?.activeKind;
  const updateIncludedBranch = dock?.updateIncludedBranch;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the workspace-owned preview in step with the active thread branch
  useEffect(() => {
    if (!panelOnly && activeDockKind === "included") updateIncludedBranch?.(branch ?? null);
  }, [panelOnly, activeDockKind, branch, updateIncludedBranch]);
  const stateQuery = useEnvironmentQuery(
    monarchEnvironment.context.live({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const query = useEnvironmentQuery(
    monarchEnvironment.context.brief({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        ...(branch ? { branch } : {}),
      },
    }),
  );
  const lastScopeRevision = useRef<string | null>(null);
  const revision = stateQuery.data?.revision;
  const scopeRevision =
    revision === undefined
      ? null
      : `${projectRef.environmentId}:${projectRef.projectId}:${branch ?? ""}:${revision}`;
  const refreshBrief = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the one-shot brief query in step with the live project revision
  useEffect(() => {
    if (scopeRevision === null) return;
    if (lastScopeRevision.current !== scopeRevision) {
      refreshBrief();
    }
    lastScopeRevision.current = scopeRevision;
  }, [scopeRevision, refreshBrief]);
  const context = query.data ? boundedProjectContextSnapshot(query.data) : null;
  if (!context?.text && !panelOnly) return null;

  const panel = (
    <MonarchPanelShell
      title="Context for your next message"
      description={
        <>
          Project context revision {context?.revision ?? "unavailable"}
          {branch ? ` for ${branch}` : ""}. This is the bounded context prepared for the next
          message.
        </>
      }
      presentation={dock ? "docked" : "sheet"}
      open
      onClose={() => (onClose ? onClose() : dock ? dock.close() : setOpen(false))}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        {context?.truncated ? (
          <p className="mb-3 text-xs text-muted-foreground">Shortened to fit the provider limit.</p>
        ) : null}
        {context?.text ? (
          <pre className="font-sans text-xs leading-relaxed whitespace-pre-wrap break-words">
            {context.text}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">No project context is available now.</p>
        )}
      </div>
    </MonarchPanelShell>
  );
  if (panelOnly) return panel;

  return (
    <>
      {context?.text ? (
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => (dock ? dock.open("included", branch) : setOpen(true))}
        >
          <BookOpenIcon /> Project context
        </Button>
      ) : null}
      {!dock && open ? panel : null}
    </>
  );
}
