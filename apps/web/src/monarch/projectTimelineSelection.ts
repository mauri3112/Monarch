import type { MonarchTimelineEvent } from "@t3tools/contracts";
import type { TimelineSelection } from "./MonarchDockContext";

/** An overview row owns events for its entity, never a title-matched neighbour. */
export function selectTimelineEvent(
  events: readonly MonarchTimelineEvent[],
  selection: TimelineSelection | null | undefined,
): MonarchTimelineEvent | null {
  if (!selection) return null;
  const matches = events.filter(
    (event) => event.entityKind === selection.entityKind && event.entityId === selection.entityId,
  );
  if (selection.eventId) return matches.find((event) => event.id === selection.eventId) ?? null;
  if (selection.occurrence === "next") {
    return matches.find((event) => event.state === "upcoming") ?? null;
  }
  const candidates =
    selection.occurrence === "last"
      ? matches.filter((event) => event.state !== "upcoming" && event.runId !== null)
      : matches;
  const priority = (event: MonarchTimelineEvent) => {
    if (event.at === null && event.action === "Waiting on delegated work") return 1;
    switch (event.state) {
      case "needs-input":
        return 4;
      case "running":
        return 3;
      case "upcoming":
        return 2;
      case "paused":
      case "conditional":
        return 1;
      default:
        return 0;
    }
  };
  return (
    [...candidates].sort(
      (a, b) =>
        (selection.occurrence ? 0 : priority(b) - priority(a)) ||
        (b.at ?? "").localeCompare(a.at ?? "") ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}
