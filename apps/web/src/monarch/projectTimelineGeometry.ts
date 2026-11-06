import type { MonarchTimelineEvent } from "@t3tools/contracts";

export interface TimelineMarkerPoint {
  x: number;
  y: number;
  rowTop: number;
  rowBottom: number;
  radius: number;
  labelGap: number;
}

type Point = Pick<TimelineMarkerPoint, "x" | "y">;

function bridge(source: Point, destination: Point, boundary: number): string {
  if (source.x === destination.x) return `V ${destination.y}`;
  const dx = destination.x - source.x;
  const dy = destination.y - source.y;
  const radius = Math.min(
    16,
    Math.abs(dx) / 2,
    Math.abs(boundary - source.y),
    Math.abs(destination.y - boundary),
  );
  const rx = Math.sign(dx) * radius;
  const ry = Math.sign(dy) * radius;
  return [
    `V ${boundary - ry}`,
    `Q ${source.x} ${boundary} ${source.x + rx} ${boundary}`,
    `H ${destination.x - rx}`,
    `Q ${destination.x} ${boundary} ${destination.x} ${boundary + ry}`,
    `V ${destination.y}`,
  ].join(" ");
}

function entryGap(source: TimelineMarkerPoint, destination: TimelineMarkerPoint) {
  return source.y < destination.y ? destination.rowTop : destination.rowBottom;
}

function markerPath(source: TimelineMarkerPoint, destination: TimelineMarkerPoint) {
  return `M ${source.x} ${source.y} ${bridge(source, destination, entryGap(source, destination))}`;
}

type Node = Pick<MonarchTimelineEvent, "id" | "entityId" | "family" | "parentIds">;
type Pin = TimelineMarkerPoint & { id: string };
type Fork = { origin: Pin; children: Pin[] };

export interface TimelineWire {
  kind: "fork" | "twig" | "revision" | "sent" | "source";
  from: string;
  to: string;
  path: string;
}

export function timelineWires(
  events: readonly Node[],
  pins: ReadonlyMap<string, TimelineMarkerPoint>,
) {
  const nodes = new Map(events.map((node) => [node.id, node]));
  const forks: Fork[] = [];
  const sends: { origin: Pin; destination: Pin }[] = [];
  const wires: TimelineWire[] = [];
  let lastFork: Fork | undefined;
  let previousProposal: Node | undefined;
  for (const node of events) {
    const destination = pins.get(node.id);
    if (!destination) continue;
    let currentFork: Fork | undefined;
    for (const id of node.parentIds) {
      const parent = nodes.get(id);
      const origin = pins.get(id);
      if (!parent || !origin) continue;
      if (node.family === "suggestion" && parent.family !== "suggestion") {
        currentFork = lastFork?.origin.id === id ? lastFork : undefined;
        if (!currentFork) {
          currentFork = { origin: { id, ...origin }, children: [] };
          forks.push(currentFork);
        }
        currentFork.children.push({ id: node.id, ...destination });
      } else if (node.family === "thread" && parent.family === "suggestion") {
        sends.push({ origin: { id, ...origin }, destination: { id: node.id, ...destination } });
      } else if (origin.x !== destination.x) {
        wires.push({
          kind: "source",
          from: id,
          to: node.id,
          path: markerPath(origin, destination),
        });
      } else if (
        node.family === "suggestion" &&
        previousProposal?.id === id &&
        node.entityId === parent.entityId
      ) {
        // A straight revision link must never pass through another proposal.
        wires.push({
          kind: "revision",
          from: id,
          to: node.id,
          path: markerPath(origin, destination),
        });
      }
    }
    if (node.family === "suggestion") {
      lastFork = currentFork;
      previousProposal = node;
    }
  }

  for (const { origin, children } of forks) {
    const first = children[0]!;
    const last = children[children.length - 1]!;
    if (children.length === 1 || origin.y >= first.y) {
      for (const child of children) {
        wires.push({
          kind: "fork",
          from: origin.id,
          to: child.id,
          path: markerPath(origin, child),
        });
      }
      continue;
    }
    // Only siblings from the same recorded review share a bracket. Its taps end at their own stars.
    const side = Math.sign(first.x - origin.x);
    const stem = first.x - side * (first.radius + 6);
    const tip = 6;
    const shoulder = entryGap(origin, first);
    const path = `M ${origin.x} ${origin.y} ${bridge(origin, { x: stem, y: last.y - tip }, shoulder)} Q ${stem} ${last.y} ${stem + side * tip} ${last.y} H ${last.x}`;
    wires.push({ kind: "fork", from: origin.id, to: last.id, path });
    for (const child of children.slice(0, -1)) {
      wires.push({
        kind: "twig",
        from: origin.id,
        to: child.id,
        path: `M ${stem} ${child.y} H ${child.x}`,
      });
    }
  }

  // Overlapping sends use distinct positions inside the measured gap between the star and its text.
  sends.sort(
    (a, b) => Math.min(a.origin.y, a.destination.y) - Math.min(b.origin.y, b.destination.y),
  );
  const ends: number[] = [];
  const channels = sends.map(({ origin, destination }) => {
    const free = ends.findIndex((end) => end < Math.min(origin.y, destination.y));
    const slot = free < 0 ? ends.length : free;
    ends[slot] = Math.max(origin.y, destination.y);
    return slot;
  });
  for (const [index, { origin, destination }] of sends.entries()) {
    const offset = origin.radius + (origin.labelGap * (channels[index]! + 1)) / (ends.length + 1);
    const channel = origin.x + offset;
    const exit = { x: channel, y: origin.y + Math.sign(destination.y - origin.y) * offset };
    const path = `M ${origin.x} ${origin.y} Q ${channel} ${origin.y} ${exit.x} ${exit.y} ${bridge(exit, destination, entryGap(origin, destination))}`;
    wires.push({ kind: "sent", from: origin.id, to: destination.id, path });
  }
  return wires;
}
