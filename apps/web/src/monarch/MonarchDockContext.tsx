import { createContext, useContext } from "react";
import type { MonarchProjectDocument } from "./projectDocuments";
export type { MonarchProjectDocument } from "./projectDocuments";

export type MonarchDockKind = "timeline" | "context" | "settings" | "included";

export interface TimelineSelection {
  readonly entityKind:
    | "target"
    | "thread"
    | "suggestion"
    | "prompt-schedule"
    | "review-schedule"
    | "review"
    | "journal";
  readonly entityId: string;
  readonly occurrence?: "next" | "last";
  readonly eventId?: string;
}

export interface MonarchDockController {
  readonly activeDocument?: MonarchProjectDocument | null;
  readonly documentHost?: HTMLElement | null;
  readonly openDocument?: (document: MonarchProjectDocument) => void;
  readonly closeDocument?: () => void;
  readonly showTimeline?: () => void;
  readonly hoveredEntityKey?: string | null;
  readonly hoverEntity?: (key: string | null) => void;
  readonly selection?: TimelineSelection | null;
  readonly selectEntity?: (selection: TimelineSelection | null) => void;
  readonly actionHost?: HTMLElement | null;
  readonly setActionHost?: (host: HTMLElement | null) => void;
  readonly activeKind: MonarchDockKind | null;
  readonly host: HTMLElement | null;
  readonly open: (kind: MonarchDockKind, branch?: string | null) => void;
  readonly close: () => void;
  readonly updateIncludedBranch: (branch: string | null) => void;
}

export const MonarchDockContext = createContext<MonarchDockController | null>(null);

export function useMonarchDock(): MonarchDockController | null {
  return useContext(MonarchDockContext);
}

export function timelineRowProps(
  dock: MonarchDockController | null,
  kind: TimelineSelection["entityKind"],
  id: string,
) {
  const key = `${kind}:${id}`;
  return {
    "data-timeline-hovered": dock?.hoveredEntityKey === key,
    onMouseEnter: () => dock?.hoverEntity?.(key),
    onMouseLeave: () => dock?.hoverEntity?.(null),
    onFocus: () => dock?.hoverEntity?.(key),
    onBlur: () => dock?.hoverEntity?.(null),
  };
}
