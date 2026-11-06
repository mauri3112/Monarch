import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MonarchTimelineEvent, ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { monarchEnvironment } from "../state/monarch";
import { useQuietThreadShells } from "../state/entities";
import { overlayCurrentThreadActivity } from "./projectTimelineCurrentState";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";
import { useMonarchDock } from "./MonarchDockContext";
import { ProjectTimeline } from "./ProjectTimeline";
import { selectTimelineEvent } from "./projectTimelineSelection";

export function ProjectActivityDock({
  projectRef,
  expanded,
  onToggleExpanded,
}: {
  projectRef: ScopedProjectRef;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const dock = useMonarchDock();
  const threads = useQuietThreadShells();
  const selection = dock?.selection;
  const baseQuery = useEnvironmentQuery(
    monarchEnvironment.timeline.live({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const focusedQuery = useEnvironmentQuery(
    selection
      ? monarchEnvironment.timeline.live({
          environmentId: projectRef.environmentId,
          input: {
            projectId: projectRef.projectId,
            focus: {
              entityKind: selection.entityKind,
              entityId: selection.entityId,
              ...(selection.eventId ? { eventId: selection.eventId } : {}),
            },
          },
        })
      : null,
  );
  const visibilityKey = baseQuery.data?.visibilityKey ?? "";
  const [paging, setPaging] = useState<{
    visibilityKey: string;
    pages: ReadonlyArray<{ before: { at: string; id: string } }>;
    index: number;
  }>({ visibilityKey, pages: [], index: -1 });
  // Excluded or removed sources invalidate both the visible page and its cursors.
  const pageState =
    paging.visibilityKey === visibilityKey ? paging : { visibilityKey, pages: [], index: -1 };
  const historyPage = pageState.index;
  const historyRequest = pageState.pages[historyPage] ?? null;
  const history = useEnvironmentQuery(
    historyRequest
      ? monarchEnvironment.timeline.history({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId, ...historyRequest, visibilityKey },
        })
      : null,
  );
  const currentQuery = selection ? focusedQuery : baseQuery;
  const current =
    currentQuery.data?.visibilityKey === visibilityKey ? currentQuery.data : baseQuery.data;
  const visibleHistory = history.data?.visibilityKey === visibilityKey ? history.data : null;
  const events = new Map(visibleHistory?.events.map((event) => [event.id, event]));
  for (const event of current?.events ?? []) events.set(event.id, event);
  const nextCursor = visibleHistory ? visibleHistory.nextCursor : baseQuery.data?.nextCursor;
  const query = {
    ...currentQuery,
    data: current
      ? {
          ...current,
          events: [...overlayCurrentThreadActivity([...events.values()], threads, projectRef)].sort(
            (a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999") || a.id.localeCompare(b.id),
          ),
          hasOlder: nextCursor != null,
        }
      : null,
  };
  const loadOlder = () => {
    if (!nextCursor || history.isPending) return;
    const index = historyPage + 1;
    setPaging({
      visibilityKey,
      pages: pageState.pages[index]
        ? pageState.pages
        : [...pageState.pages, { before: nextCursor }],
      index,
    });
  };
  const selected = selectTimelineEvent(query.data?.events ?? [], selection);
  const choose = (event: MonarchTimelineEvent | null) =>
    dock?.selectEntity?.(
      event
        ? {
            entityKind: event.entityKind,
            entityId: event.entityId,
            eventId: event.id,
          }
        : null,
    );
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="Project Timeline">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-medium">Timeline</h2>
        <div className="flex items-center gap-1">
          {historyPage >= 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => setPaging({ ...pageState, index: historyPage - 1 })}
            >
              Newer activity
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={expanded ? "Reduce Timeline" : "Expand Timeline"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Hide Timeline" onClick={dock?.close}>
            <XIcon />
          </Button>
        </div>
      </header>
      {query.error || history.error ? (
        <p role="alert" className="p-4 text-xs text-destructive">
          Could not load {history.error ? "older activity" : "Timeline"}.{" "}
          <Button
            size="xs"
            variant="ghost"
            onClick={history.error ? history.refresh : query.refresh}
          >
            Retry
          </Button>
        </p>
      ) : null}
      {!query.data && !query.error ? (
        <p role="status" className="p-4 text-xs text-muted-foreground">
          Loading project activity…
        </p>
      ) : query.data ? (
        <ProjectTimeline
          timeline={query.data}
          selectedNodeId={selected?.id ?? null}
          onSelectNode={choose}
          onLoadOlder={loadOlder}
          loadingOlder={history.isPending}
          hoveredEntityKey={dock?.hoveredEntityKey ?? null}
          onHoverEntity={(key) => dock?.hoverEntity?.(key)}
          renderActions={(event) => (
            <>
              {event.threadId ? (
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(projectRef.environmentId, event.threadId),
                      )}
                    />
                  }
                >
                  {event.state === "needs-input" ? "Reply" : "Open thread"}
                </Button>
              ) : null}
              {event.parentIds.map((parentId) => {
                const parent = query.data?.events.find((item) => item.id === parentId);
                return parent ? (
                  <Button
                    key={parentId}
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => choose(parent)}
                  >
                    {parent.entityKind === "journal"
                      ? "Source journal"
                      : parent.family === "model"
                        ? "Source review"
                        : "Source event"}{" "}
                    · {parent.title}
                    {parent.at ? ` · ${new Date(parent.at).toLocaleString()}` : ""}
                  </Button>
                ) : null;
              })}
              <div ref={dock?.setActionHost} className="contents" data-timeline-action-host />
            </>
          )}
        />
      ) : null}
    </section>
  );
}
