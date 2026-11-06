import type { MonarchTimelineEvent, MonarchTimelineResult } from "@t3tools/contracts";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { observeResize } from "../lib/observeResize";
import {
  timelineWires,
  type TimelineWire,
  type TimelineMarkerPoint,
} from "./projectTimelineGeometry";
import styles from "./ProjectTimeline.module.css";

function timelineEntityKey(event: Pick<MonarchTimelineEvent, "entityKind" | "entityId">) {
  return `${event.entityKind}:${event.entityId}`;
}

const FAMILY_LABEL = {
  target: "Target",
  thread: "Thread",
  suggestion: "Proposed thread",
  schedule: "Scheduled task",
  model: "Background action",
} as const;

const STATE_LABEL = {
  recorded: "Recorded",
  active: "Active",
  draft: "Draft",
  ready: "Ready",
  running: "Working",
  "needs-input": "Input needed",
  finished: "Finished",
  upcoming: "Upcoming",
  conditional: "When ready",
  failed: "Failed",
  interrupted: "Interrupted",
  archived: "Archived",
  achieved: "Achieved",
  paused: "Paused",
} as const;

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const rowDateFormatter = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function parsedDate(at: string | null): Date | null {
  if (!at) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventDay(event: MonarchTimelineEvent) {
  if (event.state === "conditional") return "When ready";
  const date = parsedDate(event.at);
  if (!date) return "Project activity";
  return dayFormatter.format(date);
}

function lane(event: MonarchTimelineEvent) {
  return event.family === "thread" ? "work" : event.family === "target" ? "project" : "actions";
}

function inlineTransition(event: MonarchTimelineEvent) {
  if (event.family === "target" && event.state !== "recorded") {
    return `${STATE_LABEL[event.state]} target`;
  }
  if (event.state === "needs-input") {
    return event.action.toLowerCase().includes("approval") ? "Approval needed" : "Input needed";
  }
  return event.action;
}

export interface ProjectTimelineProps {
  timeline: MonarchTimelineResult;
  selectedNodeId?: string | null;
  onSelectNode?: (event: MonarchTimelineEvent | null) => void;
  onOpenEvent?: (event: MonarchTimelineEvent) => void;
  detailPresentation?: (event: MonarchTimelineEvent) => "inline" | "external";
  hoveredEntityKey?: string | null;
  onHoverEntity?: (key: string | null) => void;
  renderActions?: (event: MonarchTimelineEvent) => ReactNode;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  className?: string;
}

export function ProjectTimeline({
  timeline,
  selectedNodeId,
  onSelectNode,
  onOpenEvent,
  detailPresentation,
  hoveredEntityKey,
  onHoverEntity,
  renderActions,
  onLoadOlder,
  loadingOlder = false,
  className,
}: ProjectTimelineProps) {
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [localHover, setLocalHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [visible, setVisible] = useState(true);
  const [geometry, setGeometry] = useState({ width: 0, height: 0, paths: [] as TimelineWire[] });
  const graphRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const markers = useRef(new Map<string, HTMLSpanElement>());
  const initiallyPositioned = useRef(false);
  const headingId = useId();
  const keyboardHelpId = useId();
  const selectedId = selectedNodeId === undefined ? localSelected : selectedNodeId;
  const selected = timeline.events.find((event) => event.id === selectedId) ?? null;
  const selectedEventId = selected?.id;
  const selectedDate = selected ? parsedDate(selected.at) : null;
  const showDetails = selected ? detailPresentation?.(selected) !== "external" : !onOpenEvent;
  const selectedOwner = selected ? timelineEntityKey(selected) : null;
  const hoveredOwner = hoveredEntityKey ?? localHover;
  const currentEvent =
    timeline.events.findLast((event) => event.state === "needs-input") ??
    timeline.events.findLast((event) => event.state === "running") ??
    timeline.events.findLast(
      (event) => event.at !== null && event.state !== "upcoming" && event.state !== "conditional",
    ) ??
    timeline.events[0];
  const currentEventId = currentEvent?.id;
  const keyboardAnchorId = selectedEventId ?? currentEventId;

  function select(event: MonarchTimelineEvent | null) {
    setLocalSelected(event?.id ?? null);
    onSelectNode?.(event);
  }

  function hover(event: MonarchTimelineEvent | null) {
    const key = event ? timelineEntityKey(event) : null;
    setLocalHover(key);
    onHoverEntity?.(key);
  }

  function revealCurrent() {
    if (!currentEvent) return;
    select(currentEvent);
    const marker = markers.current.get(currentEvent.id);
    marker?.closest("button")?.focus({ preventScroll: true });
    const viewport = scrollRef.current;
    if (marker && viewport) {
      const bounds = viewport.getBoundingClientRect();
      viewport.scrollTop += marker.getBoundingClientRect().top - bounds.top - bounds.height * 0.3;
    }
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const destination =
      event.key === "ArrowDown"
        ? Math.min(index + 1, timeline.events.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? timeline.events.length - 1
              : null;
    if (destination === null) return;
    event.preventDefault();
    const next = timeline.events[destination];
    if (!next) return;
    select(next);
    markers.current.get(next.id)?.closest("button")?.focus({ preventScroll: true });
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Row bounds can change independently of the canvas when text wraps or details open.
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const rows = Array.from(graph.querySelectorAll<HTMLElement>("[data-timeline-row]"));
    const measure = () => {
      const bounds = graph.getBoundingClientRect();
      const positions = new Map<string, TimelineMarkerPoint>();
      const railGap = rows[0] ? Number.parseFloat(getComputedStyle(rows[0]).columnGap) || 7 : 7;
      for (const [id, marker] of markers.current) {
        const rect = marker.getBoundingClientRect();
        const row = marker.closest("[data-timeline-row]")?.getBoundingClientRect();
        const label = marker.nextElementSibling?.getBoundingClientRect();
        if (!row || !label) continue;
        positions.set(id, {
          x: rect.left + rect.width / 2 - bounds.left,
          y: rect.top + rect.height / 2 - bounds.top,
          rowTop: row.top - bounds.top,
          rowBottom: row.bottom - bounds.top,
          radius: rect.width / 2,
          labelGap: Math.max(0, label.left - rect.right),
          railGap,
        });
      }
      setGeometry({
        width: bounds.width,
        height: bounds.height,
        paths: timelineWires(timeline.events, positions),
      });
    };
    measure();
    return observeResize([graph, ...rows], measure);
  }, [timeline.events, graphRef, markers]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Initially positions the DOM viewport at current activity rather than old history.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const marker = currentEventId ? markers.current.get(currentEventId) : null;
    if (initiallyPositioned.current || !viewport || !marker) return;
    initiallyPositioned.current = true;
    if (selectedEventId) return;
    const bounds = viewport.getBoundingClientRect();
    viewport.scrollTop += marker.getBoundingClientRect().top - bounds.top - bounds.height * 0.3;
  }, [currentEventId, selectedEventId, markers]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the scroll viewport on the selected event when selection comes from the project overview.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const marker = selectedEventId ? markers.current.get(selectedEventId) : null;
    if (!viewport || !marker) return;
    const bounds = viewport.getBoundingClientRect();
    const event = marker.closest("button")?.getBoundingClientRect();
    if (!event) return;
    const visibleTop = bounds.top + (axisRef.current?.offsetHeight ?? 0) + 8;
    if (event.top < visibleTop) viewport.scrollTop += event.top - visibleTop;
    else if (event.bottom > bounds.bottom - 8)
      viewport.scrollTop += event.bottom - bounds.bottom + 8;
  }, [selectedEventId, markers]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps working animations in step with document and viewport visibility.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let inViewport = true;
    const update = () => setVisible(inViewport && document.visibilityState !== "hidden");
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? true;
      update();
    });
    observer.observe(root);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const highlightedIds = new Set(
    timeline.events
      .filter((event) => {
        const owner = timelineEntityKey(event);
        return owner === selectedOwner || owner === hoveredOwner;
      })
      .map((event) => event.id),
  );

  return (
    <section
      ref={rootRef}
      className={`${styles["project-timeline"]} ${className ?? ""}`}
      aria-label="Project and work timeline"
      data-motion={visible ? "playing" : "paused"}
      style={{ "--timeline-zoom": zoom } as CSSProperties}
    >
      <div className={styles["project-timeline-toolbar"]}>
        <span>{timeline.hasOlder ? "Recent activity · oldest first" : "Oldest to newest"}</span>
        <div className={styles["project-timeline-zoom"]} aria-label="Timeline size">
          {timeline.hasOlder && onLoadOlder ? (
            <button type="button" onClick={onLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older"}
            </button>
          ) : null}
          <button type="button" onClick={revealCurrent} disabled={!currentEvent}>
            Current activity
          </button>
          <button
            type="button"
            aria-label="Make timeline smaller"
            disabled={zoom <= 0.8}
            onClick={() => setZoom((value) => Math.max(0.8, +(value - 0.1).toFixed(1)))}
          >
            <MinusIcon aria-hidden="true" />
          </button>
          <button type="button" aria-label="Reset timeline size" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Make timeline larger"
            disabled={zoom >= 1.4}
            onClick={() => setZoom((value) => Math.min(1.4, +(value + 0.1).toFixed(1)))}
          >
            <PlusIcon aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className={styles["project-timeline-scroll"]}
        role="group"
        aria-label="Timeline events"
        aria-describedby={keyboardHelpId}
      >
        <div
          className={styles["project-timeline-axis"]}
          ref={axisRef}
          data-timeline-axis
          aria-hidden="true"
        >
          <span />
          <span>Project</span>
          <span>Actions</span>
          <span>Work</span>
        </div>
        <p className="sr-only" id={keyboardHelpId}>
          Use Up and Down arrow keys to move between events. Home and End move to the first and last
          event. Press Enter to open the selected event.
        </p>
        <div className={styles["project-timeline-canvas"]} ref={graphRef} data-timeline-canvas>
          {timeline.events.length > 0 && (
            <div className={styles["project-timeline-spines"]} aria-hidden="true">
              <span data-timeline-spine="project" />
              <span data-timeline-spine="work" />
            </div>
          )}
          {geometry.width > 0 ? (
            <svg
              className={styles["project-timeline-wires"]}
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {geometry.paths
                .filter((connection) =>
                  connection.kind === "revision"
                    ? highlightedIds.has(connection.from) || highlightedIds.has(connection.to)
                    : connection.kind !== "source" ||
                      connection.from === selectedId ||
                      connection.to === selectedId,
                )
                .map((connection) => (
                  <path
                    key={`${connection.kind}:${connection.from}:${connection.to}`}
                    d={connection.path}
                    data-connection={connection.kind}
                    data-source-event={connection.from}
                    data-destination-event={connection.to}
                    data-highlighted={
                      highlightedIds.has(connection.from) ||
                      highlightedIds.has(connection.to) ||
                      undefined
                    }
                  />
                ))}
            </svg>
          ) : null}
          {timeline.events.length === 0 ? (
            <p className={styles["project-timeline-empty"]}>
              Activity will appear as this project moves forward.
            </p>
          ) : null}
          {timeline.events.map((event, index) => {
            const previous = timeline.events[index - 1];
            const day = eventDay(event);
            const date = parsedDate(event.at);
            const owner = timelineEntityKey(event);
            const isSelected = event.id === selectedId;
            const isLinked = owner === selectedOwner || owner === hoveredOwner;
            const caption = STATE_LABEL[event.state];
            const transition = inlineTransition(event);
            return (
              <div key={event.id}>
                {!previous || eventDay(previous) !== day ? (
                  <div className={styles["project-timeline-day"]}>
                    <span>{day}</span>
                  </div>
                ) : null}
                <div
                  className={styles["project-timeline-row"]}
                  data-lane={lane(event)}
                  data-timeline-row
                >
                  <time
                    dateTime={event.at ?? undefined}
                    className={styles["project-timeline-time"]}
                  >
                    {date ? (
                      <>
                        <span>{timeFormatter.format(date)}</span>
                        <span className={styles["project-timeline-row-date"]}>
                          {rowDateFormatter.format(date)}
                        </span>
                      </>
                    ) : null}
                  </time>
                  <button
                    type="button"
                    className={styles["project-timeline-event"]}
                    data-family={event.family}
                    data-state={event.state}
                    data-selected={isSelected || undefined}
                    data-linked={isLinked || undefined}
                    tabIndex={event.id === keyboardAnchorId ? 0 : -1}
                    aria-pressed={isSelected}
                    aria-label={`${FAMILY_LABEL[event.family]}: ${event.title}. ${event.action}. ${caption}${date ? `. ${fullDateFormatter.format(date)}` : ""}`}
                    aria-controls={isSelected && showDetails ? headingId : undefined}
                    onClick={() => {
                      select(event);
                      onOpenEvent?.(event);
                    }}
                    onKeyDown={(keyEvent) => navigate(keyEvent, index)}
                    onMouseEnter={() => hover(event)}
                    onMouseLeave={() => hover(null)}
                    onFocus={() => hover(event)}
                    onBlur={() => hover(null)}
                  >
                    <span
                      className={styles["project-timeline-marker"]}
                      data-timeline-marker={event.id}
                      ref={(element) => {
                        if (element) markers.current.set(event.id, element);
                        else markers.current.delete(event.id);
                      }}
                      aria-hidden="true"
                    >
                      <span className={styles["project-timeline-ink"]} />
                      {event.state === "needs-input" ? (
                        <span className={styles["project-timeline-glyph"]}>?</span>
                      ) : event.state === "archived" || event.state === "achieved" ? (
                        <span className={styles["project-timeline-glyph"]}>✓</span>
                      ) : null}
                    </span>
                    <span className={styles["project-timeline-label"]}>
                      <span className={styles["project-timeline-title"]}>{event.title}</span>
                      {transition.trim().toLowerCase() !== event.title.trim().toLowerCase() ? (
                        <span className={styles["project-timeline-action"]}>{transition}</span>
                      ) : null}
                      <span className={styles["project-timeline-subtitle"]}>
                        {event.detail.length > 240
                          ? `${event.detail.slice(0, 240).trimEnd()}…`
                          : event.detail}
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className={styles["project-timeline-legend"]} aria-label="Timeline symbols">
        {Object.entries(FAMILY_LABEL).map(([family, label]) => (
          <span key={family} data-family={family}>
            <i className={styles["project-timeline-legend-mark"]} aria-hidden="true" />
            {label}
          </span>
        ))}
        <span className={styles["project-timeline-return-key"]}>Dotted path: sent to thread</span>
      </div>
      {showDetails ? (
        <div className={styles["project-timeline-details"]} id={headingId}>
          {selected ? (
            <>
              <div className={styles["project-timeline-details-heading"]}>
                <div>
                  <span className={styles["project-timeline-details-kind"]}>
                    {FAMILY_LABEL[selected.family]} · {STATE_LABEL[selected.state]}
                  </span>
                  <h3>{selected.title}</h3>
                  {selected.action.trim().toLowerCase() !== selected.title.trim().toLowerCase() ? (
                    <span className={styles["project-timeline-selected-action"]}>
                      {selected.action}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="Clear timeline selection"
                  onClick={() => select(null)}
                >
                  <XIcon aria-hidden="true" />
                </button>
              </div>
              <p>{selected.detail}</p>
              {selectedDate ? (
                <time dateTime={selected.at ?? undefined}>
                  {fullDateFormatter.format(selectedDate)}
                </time>
              ) : null}
              <div className={styles["project-timeline-actions"]}>{renderActions?.(selected)}</div>
            </>
          ) : (
            <p>Select an event for details and actions.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
