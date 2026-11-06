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
import { timelineWires, type TimelineMarkerPoint } from "./projectTimelineGeometry";
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

const SYMBOLS = {
  target: <path d="m12 2.5 9.5 9.5-9.5 9.5L2.5 12Z" />,
  thread: <circle cx="12" cy="12" r="8.5" />,
  suggestion: (
    <path d="M12 2c1.6 5.6 4.4 8.4 10 10-5.6 1.6-8.4 4.4-10 10C10.4 16.4 7.6 13.6 2 12c5.6-1.6 8.4-4.4 10-10Z" />
  ),
  schedule: <rect x="3.5" y="3.5" width="17" height="17" rx="2" />,
  model: <path d="m12 3 9 17H3Z" />,
} satisfies Record<MonarchTimelineEvent["family"], ReactNode>;

function TimelineSymbol({
  family,
  state,
}: Pick<MonarchTimelineEvent, "family"> & { state?: MonarchTimelineEvent["state"] }) {
  return (
    <svg
      className={styles["project-timeline-symbol"]}
      viewBox="0 0 24 24"
      fill="var(--timeline-symbol-fill, currentColor)"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SYMBOLS[family]}
      {state === "needs-input" && (
        <g stroke="var(--timeline-paper)" fill="none" strokeLinecap="round">
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" />
          <circle cx="12" cy="16" r=".9" fill="var(--timeline-paper)" stroke="none" />
        </g>
      )}
      {(state === "archived" || state === "achieved") && (
        <path
          d="m8 12 2.7 2.7 5.3-5.5"
          fill="none"
          stroke={state === "archived" ? "currentColor" : "var(--timeline-paper)"}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

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

// A narrow graph can bundle several lines. Keep each recorded relationship available by name.
function connectedActivity(events: readonly MonarchTimelineEvent[]) {
  const byId = new Map(events.map((event) => [event.id, event]));
  const names = new Map<string, Set<string>>();
  function describe(id: string, other: MonarchTimelineEvent) {
    const group = names.get(id) ?? new Set<string>();
    group.add(`${FAMILY_LABEL[other.family].toLowerCase()} “${other.title}” (${other.action})`);
    names.set(id, group);
  }
  for (const event of events) {
    for (const id of new Set([...event.parentIds, ...(event.relatedEventIds ?? [])])) {
      const other = byId.get(id);
      if (!other || lane(other) === lane(event)) continue;
      describe(event.id, other);
      describe(other.id, event);
    }
  }
  return names;
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
  const [geometry, setGeometry] = useState({
    width: 0,
    height: 0,
    projectRailX: 0,
    pins: new Map<string, TimelineMarkerPoint>(),
  });
  const graphRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const projectRailRef = useRef<HTMLSpanElement>(null);
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
  const wires = timelineWires(timeline.events, geometry.pins, {
    selectedId: selectedEventId ?? null,
    projectRailX: geometry.projectRailX,
  });
  const traced = new Set(
    wires
      .filter((wire) =>
        wire.relations.some(({ from, to }) => from === selectedId || to === selectedId),
      )
      .map((wire) => wire.key),
  );
  const connections = connectedActivity(timeline.events);

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
    const rows = timeline.events.flatMap((event) => {
      const row = markers.current.get(event.id)?.closest<HTMLElement>("[data-timeline-row]");
      return row ? [row] : [];
    });
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
      const projectRail = projectRailRef.current?.getBoundingClientRect();
      setGeometry({
        width: bounds.width,
        height: bounds.height,
        projectRailX: projectRail ? projectRail.left + projectRail.width / 2 - bounds.left : 0,
        pins: positions,
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
              <span ref={projectRailRef} data-timeline-spine="project" />
              <span data-timeline-spine="work" />
            </div>
          )}
          {geometry.width > 0 ? (
            <svg
              className={styles["project-timeline-wires"]}
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              data-tracing={traced.size > 0 || undefined}
            >
              {wires.map((wire) => (
                <path
                  key={wire.key}
                  d={wire.path}
                  strokeDashoffset={wire.dashOffset}
                  data-connection={wire.kind}
                  data-aggregate={wire.aggregate}
                  data-source-event={wire.from}
                  data-destination-event={wire.to}
                  data-highlighted={traced.has(wire.key) || undefined}
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
            const related = connections.get(event.id);
            const description = [
              event.projectScope && "Project-wide action.",
              related?.size && `Connected to ${[...related].join(", ")}.`,
            ]
              .filter(Boolean)
              .join(" ");
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
                    aria-description={description || undefined}
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
                      <TimelineSymbol family={event.family} state={event.state} />
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
                        {description && (
                          <span className={styles["project-timeline-related-note"]}>
                            {description}
                          </span>
                        )}
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
        {(Object.keys(FAMILY_LABEL) as (keyof typeof FAMILY_LABEL)[]).map((family) => (
          <span key={family} data-family={family}>
            <TimelineSymbol family={family} />
            {FAMILY_LABEL[family]}
          </span>
        ))}
        <span className={styles["project-timeline-link-key"]}>Related activity</span>
        <span className={styles["project-timeline-link-key"]} data-link="sent">
          Sent to thread
        </span>
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
