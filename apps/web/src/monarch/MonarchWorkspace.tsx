import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useProject, useQuietThreadProjection, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ProjectBoard } from "./ProjectBoard";

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
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="@container/monarch flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-thread-open={target !== null}
      data-expanded={expanded}
      inert={background}
    >
      <section
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          target !== null &&
            (expanded
              ? "hidden"
              : "hidden @min-[1001px]/monarch:flex @min-[1001px]/monarch:flex-[0_0_360px] @min-[1001px]/monarch:border-r @min-[1001px]/monarch:border-border"),
        )}
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
      </section>
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col", target === null ? "hidden" : "flex")}
        aria-label="Thread conversation"
      >
        <div
          className={cn(
            "flex min-h-[38px] items-center justify-between gap-2 border-b border-border px-2.5 py-1 @max-[1001px]/monarch:min-h-(--workspace-topbar-height) @max-[1001px]/monarch:pl-(--workspace-titlebar-content-left)",
            expanded && "pl-(--workspace-titlebar-content-left)",
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
    </div>
  );
}
