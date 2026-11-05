import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useDelegatedUnderParent,
  useHiddenThreadKeys,
  useQuietThreadShells,
} from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../state/olderSettledShelf";
import { useEnvironmentShellStatus } from "../state/shell";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  matchesProjectThreadFilter,
  selectProjectThreads,
  type ProjectThreadFilter,
} from "./projectWorkspace.logic";
import { ProjectPlanning } from "./ProjectPlanning";

const FILTERS: readonly [ProjectThreadFilter, string][] = [
  ["all", "All"],
  ["attention", "Needs attention"],
  ["working", "Working"],
  ["settled", "Settled"],
];

const STATUS_LABELS = {
  approval: "Approval needed",
  input: "Input needed",
  request: "Guest request",
  limited: "Usage limit",
  failed: "Failed",
  working: "Working",
  waiting: "Waiting",
  ready: "Ready",
} as const;

export function ProjectBoard({
  project,
  projectRef,
  selectedThreadRef,
  actions,
}: {
  project: EnvironmentProject;
  projectRef: ScopedProjectRef;
  selectedThreadRef: ScopedThreadRef | null;
  actions?: ReactNode;
}) {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const hiddenThreadKeys = useHiddenThreadKeys();
  const environment = useEnvironment(projectRef.environmentId);
  const shellStatus = useEnvironmentShellStatus(projectRef.environmentId);
  const handleNewThread = useNewThreadHandler();
  const [filter, setFilter] = useState<ProjectThreadFilter>("all");
  const [visibleCount, setVisibleCount] = useState(24);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const projectThreads = selectProjectThreads(
    threads,
    projectRef,
    delegatedUnderParent,
    hiddenThreadKeys,
  );
  const showSettled = filter === "all" || filter === "settled";
  const shelf = useOlderSettledShelf({
    scopes: [{ environmentId: projectRef.environmentId, projectIds: [projectRef.projectId] }],
    expanded: showSettled,
    visibleCount,
  });
  const settledThreads = projectThreads.filter((thread) => thread.settledOverride === "settled");
  const listedSettled = settledThreads.filter(shelf.isListed);
  useOlderSettledShelfGrowth(shelf, listedSettled);
  const visibleSettledKeys = new Set(
    listedSettled
      .slice(0, visibleCount)
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const shownThreads = projectThreads.filter(
    (thread) =>
      matchesProjectThreadFilter(thread, filter) &&
      (thread.settledOverride !== "settled" ||
        !showSettled ||
        visibleSettledKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))),
  );
  const moreSettled =
    settledThreads.length + shelf.unloadedCount(projectThreads) > visibleSettledKeys.size;

  async function startThread() {
    setStarting(true);
    setStartError(null);
    try {
      await handleNewThread(projectRef);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not open a new thread.");
    }
    setStarting(false);
  }

  return (
    <div className="mx-auto w-full max-w-[1160px] overflow-y-auto px-5 pt-6 pb-12 sm:px-6">
      <header className="mb-8">
        <span className="block text-2xs break-words text-muted-foreground">
          {environment?.label ?? "Environment unavailable"}
        </span>
        <h1 className="mt-2 text-2xl leading-tight font-medium tracking-tight break-words">
          {project.title}
        </h1>
        <p className="mt-1 block min-w-0 truncate text-xs text-muted-foreground">
          {project.workspaceRoot}
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            onClick={() => void startThread()}
            disabled={starting || project.archivedAt != null}
          >
            <PlusIcon />
            {starting ? "Opening…" : "New thread"}
          </Button>
          {actions}
        </div>
        {startError ? (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {startError}
          </p>
        ) : null}
      </header>
      <ProjectPlanning projectRef={projectRef} archived={project.archivedAt != null} />
      <section
        aria-labelledby="monarch-threads-heading"
        className="mt-8 border-t border-border pt-7"
      >
        <p className="text-3xs font-medium uppercase tracking-widest text-muted-foreground">
          04 / History
        </p>
        <div className="mt-1 flex items-center gap-2.5">
          <h2 id="monarch-threads-heading" className="text-sm font-medium">
            Threads
          </h2>
          <span className="text-2xs text-muted-foreground">{shownThreads.length} shown</span>
        </div>
        <div
          className="mt-3 mb-4 flex flex-wrap gap-1"
          role="group"
          aria-label="Filter project threads"
        >
          {FILTERS.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost-muted"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {shellStatus !== "live" ? (
          <p className="py-3 text-xs text-muted-foreground" role="status">
            Showing saved threads. Waiting for this environment to reconnect.
          </p>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-3">
          {shownThreads.map((thread) => (
            <ProjectThreadCard
              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
              thread={thread}
              selected={
                selectedThreadRef?.environmentId === thread.environmentId &&
                selectedThreadRef.threadId === thread.id
              }
            />
          ))}
        </div>
        {shownThreads.length === 0 && !shelf.loading ? (
          <p className="py-3 text-xs text-muted-foreground">
            {filter === "all"
              ? "No threads to show yet. Start one when you’re ready."
              : "No matching threads in the loaded history."}
          </p>
        ) : null}
        {showSettled && (moreSettled || shelf.loading || shelf.failed) ? (
          <div className="mt-6 space-y-2">
            {shelf.failed ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                Could not load older threads.
              </p>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={shelf.loading}
              onClick={() =>
                shelf.failed ? shelf.retry() : setVisibleCount((count) => count + 24)
              }
            >
              {shelf.loading
                ? "Loading older threads…"
                : shelf.failed
                  ? "Retry older threads"
                  : "Load older threads"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ProjectThreadCard({
  thread,
  selected,
}: {
  thread: EnvironmentThreadShell;
  selected: boolean;
}) {
  const status = resolveSidebarThreadStatus(thread);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
      className="flex min-w-0 flex-col gap-3.5 rounded-lg border border-border p-4 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[selected=true]:border-ring data-[selected=true]:bg-accent"
      data-selected={selected}
      aria-current={selected ? "page" : undefined}
    >
      <span className="flex justify-between gap-3 text-muted-foreground">
        <span
          className="inline-flex items-center gap-1.5 text-3xs data-[status=approval]:text-warning-foreground data-[status=input]:text-warning-foreground data-[status=request]:text-warning-foreground data-[status=limited]:text-warning-foreground data-[status=failed]:text-destructive"
          data-status={status}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {STATUS_LABELS[status]}
        </span>
        <ArrowUpRightIcon size={14} aria-hidden="true" />
      </span>
      <h3 className="text-sm leading-relaxed font-medium break-words">
        {thread.title || "Untitled thread"}
      </h3>
      <span className="mt-auto flex justify-between gap-3 text-3xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1 truncate">
          {thread.branch ? (
            <>
              <GitBranchIcon size={12} aria-hidden="true" />
              {thread.branch}
            </>
          ) : thread.settledOverride === "settled" ? (
            "Settled"
          ) : (
            "Conversation"
          )}
        </span>
        <time
          className="shrink-0"
          dateTime={thread.updatedAt}
          aria-label={new Date(thread.updatedAt).toLocaleString()}
        >
          {new Date(thread.updatedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </time>
      </span>
    </Link>
  );
}
