import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { PreviewPanelShell } from "../components/preview/PreviewPanelShell";
import { useElementWidthBelow } from "../hooks/useElementWidthBelow";
import { usePreviewPanelInlineSize } from "../hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../hooks/useResizableWidth";
import { observeResize } from "../lib/observeResize";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useProject, useQuietThreadProjection, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ProjectBoard } from "./ProjectBoard";
import {
  MonarchDockContext,
  type MonarchDockKind,
  type TimelineSelection,
} from "./MonarchDockContext";
import { ProjectActivityDock } from "./ProjectActivityDock";
import { ProjectContextIncludedNotice } from "./ProjectContextIncludedNotice";

export function MonarchWorkspace({
  target,
  projectRef: routeProjectRef,
  background = false,
  projectActions,
  threadActions,
}: {
  target: ThreadRouteTarget | null;
  projectRef: ScopedProjectRef | null;
  background?: boolean;
  projectActions?: (projectRef: ScopedProjectRef) => ReactNode;
  threadActions?: (threadRef: ScopedThreadRef) => ReactNode;
}) {
  const threadRef = target?.kind === "server" ? target.threadRef : null;
  const thread = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? store.getDraftSession(target.draftId)
      : threadRef
        ? store.getDraftSessionByRef(threadRef)
        : null,
  );
  // An older direct link can load its detail before joining the shell inventory.
  const unlistedThread = useQuietThreadProjection(
    threadRef !== null && thread === null && draft === null ? threadRef : null,
  );
  const threadProjectId =
    thread?.projectId ?? draft?.projectId ?? unlistedThread?.projection.thread.projectId;
  const threadEnvironmentId = threadRef?.environmentId ?? draft?.environmentId;
  const projectRef =
    threadProjectId && threadEnvironmentId
      ? scopeProjectRef(threadEnvironmentId, threadProjectId)
      : routeProjectRef;
  const project = useProject(projectRef);
  const shellStatus = useEnvironmentShellStatus(projectRef?.environmentId ?? null);
  const [actionHost, setActionHost] = useState<HTMLElement | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const scopeKey = projectRef ? scopedProjectKey(projectRef) : "none";
  const [hoverState, setHoveredEntityKey] = useState<{ scopeKey: string; value: string | null }>({
    scopeKey,
    value: null,
  });
  const hoveredEntityKey = hoverState.scopeKey === scopeKey ? hoverState.value : null;
  const [selectionState, setSelection] = useState<{
    scopeKey: string;
    value: TimelineSelection | null;
  }>({ scopeKey, value: null });
  const selection = selectionState.scopeKey === scopeKey ? selectionState.value : null;
  const targetKey =
    target?.kind === "server" ? scopedThreadKey(target.threadRef) : (target?.draftId ?? null);
  const [dockState, setDockState] = useState<{
    scopeKey: string;
    kind: MonarchDockKind | null;
    targetKey: string | null;
    branch: string | null;
  }>({
    scopeKey,
    kind: target === null ? "timeline" : null,
    targetKey: null,
    branch: null,
  });
  if (
    dockState.scopeKey !== scopeKey ||
    (dockState.kind === "included" && dockState.targetKey !== targetKey)
  ) {
    setDockState({
      scopeKey,
      kind: target === null ? "timeline" : null,
      targetKey: null,
      branch: null,
    });
  }
  const activeDock =
    dockState.scopeKey === scopeKey &&
    (dockState.kind !== "included" || dockState.targetKey === targetKey)
      ? dockState.kind
      : null;
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [threadRowElement, setThreadRowElement] = useState<HTMLDivElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1280);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep resize bounds in step with the Monarch workspace element
  useLayoutEffect(() => {
    if (!workspaceElement) return;
    const measure = () => setWorkspaceWidth(workspaceElement.clientWidth);
    measure();
    return observeResize(workspaceElement, measure);
  }, [workspaceElement]);
  const compactDock = useElementWidthBelow(workspaceElement, 800);
  const boardVisible =
    target === null
      ? activeDock === null || !compactDock
      : !expanded && workspaceWidth >= (activeDock === null ? 1001 : 1500);
  const boardResizable = boardVisible && target !== null;
  const boardMaximum = Math.max(
    280,
    workspaceWidth - (activeDock !== null && target !== null ? 720 : 360),
  );
  const boardWidth = useResizableWidth({
    storageKey: "monarch:project-board-width",
    defaultWidth: 360,
    minWidth: 280,
    maxWidth: boardMaximum,
    edge: "right",
  });
  const dockController = {
    activeKind: activeDock,
    selection,
    hoveredEntityKey,
    hoverEntity: (value: string | null) => setHoveredEntityKey({ scopeKey, value }),
    selectEntity: (next: TimelineSelection | null) => {
      setSelection({ scopeKey, value: next });
      setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
    },
    actionHost,
    setActionHost,
    host: dockHost,
    open: (kind: MonarchDockKind, branch?: string | null) =>
      setDockState({
        scopeKey,
        kind,
        targetKey: kind === "included" ? targetKey : null,
        branch: kind === "included" ? (branch ?? null) : null,
      }),
    close: () => setDockState({ scopeKey, kind: null, targetKey: null, branch: null }),
    updateIncludedBranch: (branch: string | null) =>
      setDockState((current) =>
        current.scopeKey === scopeKey &&
        current.kind === "included" &&
        current.targetKey === targetKey &&
        current.branch !== branch
          ? { ...current, branch }
          : current,
      ),
  };
  const dockInlineSize = usePreviewPanelInlineSize({
    container: target === null ? workspaceElement : threadRowElement,
    widthStorageKey: `monarch:project-dock-width:${scopeKey}`,
    defaultWidth: activeDock === "timeline" ? 540 : 420,
  });
  const dockPane =
    activeDock !== null && projectRef ? (
      <PreviewPanelShell
        mode={compactDock ? "embedded" : "inline"}
        inlineSize={
          timelineExpanded && activeDock === "timeline"
            ? { ...dockInlineSize, width: Math.max(420, workspaceWidth - 320) }
            : dockInlineSize
        }
        workspaceArea
        workspaceLabel="Project panel"
      >
        <div ref={setDockHost} className="h-full min-h-0 min-w-0" data-monarch-dock-host>
          {activeDock === "timeline" ? (
            <ProjectActivityDock
              key={scopeKey}
              projectRef={projectRef}
              expanded={timelineExpanded}
              onToggleExpanded={() => setTimelineExpanded((value) => !value)}
            />
          ) : null}
          {activeDock === "included" ? (
            <ProjectContextIncludedNotice
              projectRef={projectRef}
              branch={dockState.branch}
              panelOnly
              onClose={dockController.close}
            />
          ) : null}
        </div>
      </PreviewPanelShell>
    ) : null;

  return (
    <MonarchDockContext value={dockController}>
      <div
        ref={setWorkspaceElement}
        className="@container/monarch flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        data-thread-open={target !== null}
        data-expanded={expanded}
        data-dock-open={activeDock !== null}
        inert={background}
      >
        <section
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col",
            boardResizable ? "shrink-0 border-r border-border" : "flex-1",
            !boardVisible && "hidden",
          )}
          style={
            boardResizable
              ? ({
                  [RESIZABLE_WIDTH_PROPERTY]: `${boardWidth.width}px`,
                  width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
                } as CSSProperties)
              : undefined
          }
          {...workspaceAreaProps("home", 1, "Project workspace")}
          aria-label="Project workspace"
        >
          <WorkspacePageHeader electron={isElectron}>
            <Button size="sm" variant="ghost" render={<Link to="/" />}>
              <ArrowLeftIcon /> Projects
            </Button>
          </WorkspacePageHeader>
          {project && projectRef ? (
            <ProjectBoard
              key={scopedProjectKey(projectRef)}
              project={project}
              projectRef={projectRef}
              selectedThreadRef={threadRef}
              actions={projectActions?.(projectRef)}
            />
          ) : (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-18 text-center text-muted-foreground"
              role="status"
            >
              <h1>
                {shellStatus === "live" && projectRef ? "Project unavailable" : "Loading project…"}
              </h1>
              <p>
                {shellStatus === "live" && projectRef
                  ? "Choose another project from your library."
                  : "Waiting for this environment’s project information."}
              </p>
            </div>
          )}
          {boardResizable ? (
            <div
              role="separator"
              aria-label="Resize project workspace"
              aria-orientation="vertical"
              className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize select-none"
              onDoubleClick={() => boardWidth.setWidth(360)}
              {...boardWidth.handlers}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-border group-active:bg-primary/60"
              />
            </div>
          ) : null}
        </section>
        <div
          ref={setThreadRowElement}
          className={cn(
            "flex min-h-0 min-w-0",
            target !== null || (activeDock !== null && compactDock)
              ? "flex-1"
              : activeDock !== null
                ? "shrink-0"
                : "hidden",
          )}
        >
          <section
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              target === null || (activeDock !== null && compactDock) ? "hidden" : "flex",
            )}
            aria-label="Thread conversation"
          >
            <div
              className={cn(
                "flex min-h-[38px] items-center justify-between gap-2 border-b border-border px-2.5 py-1",
                !boardVisible &&
                  "min-h-(--workspace-topbar-height) pl-(--workspace-titlebar-content-left)",
              )}
            >
              <Button
                size="sm"
                variant="ghost"
                render={
                  projectRef ? (
                    <Link to="/workspace/$environmentId/$projectId" params={projectRef} />
                  ) : (
                    <Link to="/" />
                  )
                }
              >
                <ArrowLeftIcon />
                <span className="max-w-[120px] truncate sm:max-w-[180px]">
                  {project?.title ?? "Projects"}
                </span>
              </Button>
              <div className="flex items-center gap-1">
                {threadRef ? threadActions?.(threadRef) : null}
                <span className="hidden @min-[1001px]/monarch:block">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={expanded ? "Show project beside thread" : "Expand thread"}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
                  </Button>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close thread pane"
                  render={
                    projectRef ? (
                      <Link to="/workspace/$environmentId/$projectId" params={projectRef} />
                    ) : (
                      <Link to="/" />
                    )
                  }
                >
                  <XIcon />
                </Button>
              </div>
            </div>
            {target ? <ThreadRouteView target={target} background={background} contained /> : null}
          </section>
          {dockPane}
        </div>
      </div>
    </MonarchDockContext>
  );
}
