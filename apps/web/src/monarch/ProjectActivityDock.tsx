import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MonarchJournalRef, MonarchTimelineEvent, ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { monarchEnvironment } from "../state/monarch";
import { useQuietThreadShells } from "../state/entities";
import { overlayCurrentThreadActivity } from "./projectTimelineCurrentState";
import { useEnvironmentQuery } from "../state/query";
import { useMonarchDock } from "./MonarchDockContext";
import { ProjectTimeline } from "./ProjectTimeline";
import styles from "./ProjectTimeline.module.css";
import { selectTimelineEvent } from "./projectTimelineSelection";
import { TimelineHeaderAction } from "./TimelineHeaderAction";

const journalTabTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const linkLabel = {
  target: "Related target",
  thread: "Related thread",
  journal: "Source journal",
  review: "Source review",
  suggestion: "Source event",
  "prompt-schedule": "Source event",
  "review-schedule": "Source event",
} satisfies Record<MonarchTimelineEvent["entityKind"], string>;

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
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
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
  function journalDocument(ref: MonarchJournalRef) {
    const receipt = query.data?.events.find(
      (node) =>
        node.entityKind === "journal" &&
        node.journalRefs?.some(
          (candidate) => candidate.runId === ref.runId && candidate.revision === ref.revision,
        ),
    );
    const date = receipt?.at ? new Date(receipt.at) : null;
    const at = date && Number.isFinite(date.getTime()) ? journalTabTime.format(date) : null;
    return {
      kind: "journal" as const,
      ...ref,
      title: ["Journal", at, `r${ref.revision}`].filter(Boolean).join(" · "),
    };
  }
  function documentFor(event: MonarchTimelineEvent) {
    if (event.entityKind === "thread" && event.threadId)
      return {
        kind: "thread" as const,
        threadRef: scopeThreadRef(projectRef.environmentId, event.threadId),
        title: event.title,
      };
    if (event.entityKind === "suggestion")
      return { kind: "suggestion" as const, suggestionId: event.entityId, title: event.title };
    if (
      (event.entityKind === "journal" || event.modelStage === "journal") &&
      event.journalRefs?.length === 1 &&
      event.journalRefs[0]
    )
      return journalDocument(event.journalRefs[0]);
    return null;
  }
  function open(event: MonarchTimelineEvent) {
    const document = documentFor(event);
    if (document) dock?.openDocument?.(document);
  }
  return (
    <section
      className="@container/project-timeline flex h-full min-h-0 min-w-0 flex-col"
      aria-label="Project Timeline"
    >
      <header className={styles["project-timeline-header"]}>
        <h2 className="text-sm font-medium">Timeline</h2>
        <div ref={setControlsHost} />
        <div className={styles["project-timeline-panel-actions"]}>
          {(query.data?.hasOlder || historyPage >= 0) && (
            <div
              role="group"
              aria-label="Timeline history"
              className={styles["project-timeline-history"]}
            >
              {query.data?.hasOlder && (
                <TimelineHeaderAction
                  label={history.isPending ? "Loading…" : "Load older"}
                  icon={ArrowUpIcon}
                  onClick={loadOlder}
                  disabled={history.isPending}
                />
              )}
              {historyPage >= 0 && (
                <TimelineHeaderAction
                  label="Newer activity"
                  icon={ArrowDownIcon}
                  onClick={() => setPaging({ ...pageState, index: historyPage - 1 })}
                />
              )}
            </div>
          )}
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
          controlsHost={controlsHost}
          selectedNodeId={selected?.id ?? null}
          onSelectNode={choose}
          onOpenEvent={open}
          detailPresentation={(event) => (documentFor(event) ? "external" : "inline")}
          hoveredEntityKey={dock?.hoveredEntityKey ?? null}
          onHoverEntity={(key) => dock?.hoverEntity?.(key)}
          renderActions={(event) => (
            <>
              {event.threadId ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    if (event.threadId)
                      dock?.openDocument?.({
                        kind: "thread",
                        threadRef: scopeThreadRef(projectRef.environmentId, event.threadId),
                        title:
                          threads.find(
                            (thread) =>
                              thread.environmentId === projectRef.environmentId &&
                              thread.id === event.threadId,
                          )?.title ?? "Source thread",
                      });
                  }}
                >
                  {event.state === "needs-input" ? "Reply" : "Open thread"}
                </Button>
              ) : null}
              {event.journalRefs?.map((ref, index) => {
                const document = journalDocument(ref);
                return (
                  <Button
                    key={`${ref.runId}:${ref.revision}`}
                    size="xs"
                    variant="outline"
                    onClick={() => dock?.openDocument?.(document)}
                  >
                    {event.journalRefs?.length === 1 ? "Read journal" : `Read journal ${index + 1}`}{" "}
                    · r{ref.revision}
                  </Button>
                );
              })}
              {[...new Set([...event.parentIds, ...(event.relatedEventIds ?? [])])].map((id) => {
                const linked = query.data?.events.find((item) => item.id === id);
                return linked &&
                  !(
                    linked.entityKind === "journal" &&
                    event.journalRefs?.some((ref) =>
                      linked.journalRefs?.some(
                        (candidate) =>
                          candidate.runId === ref.runId && candidate.revision === ref.revision,
                      ),
                    )
                  ) ? (
                  <Button
                    key={id}
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => {
                      choose(linked);
                      open(linked);
                    }}
                  >
                    {linkLabel[linked.entityKind]} · {linked.title}
                    {linked.at ? ` · ${new Date(linked.at).toLocaleString()}` : ""}
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
