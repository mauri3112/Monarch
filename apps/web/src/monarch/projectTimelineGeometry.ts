import type { MonarchTimelineEvent } from "@t3tools/contracts";

export interface TimelineMarkerPoint {
  x: number;
  y: number;
  rowTop: number;
  rowBottom: number;
  radius: number;
  labelGap: number;
  railGap?: number;
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

function actionExitPath(source: TimelineMarkerPoint, destination: TimelineMarkerPoint) {
  const channel = source.x + source.radius + source.labelGap / 2;
  const exit = {
    x: channel,
    y: source.y + Math.sign(destination.y - source.y) * (channel - source.x),
  };
  return `M ${source.x} ${source.y} Q ${channel} ${source.y} ${exit.x} ${exit.y} ${bridge(exit, destination, entryGap(source, destination))}`;
}

type Node = Pick<MonarchTimelineEvent, "id" | "entityId" | "family" | "parentIds">;
type Pin = TimelineMarkerPoint & { id: string };
type Fork = { origin: Pin; children: Pin[] };
type SideFork = Fork & { kind: "fork" | "causal" | "revision" };

export interface TimelineWire {
  kind: "fork" | "twig" | "revision" | "sent" | "source" | "causal";
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
  const sideForks = new Map<string, SideFork>();
  const childCounts = new Map<string, number>();
  const sends: { origin: Pin; destination: Pin }[] = [];
  const wires: TimelineWire[] = [];
  let lastFork: Fork | undefined;
  for (const node of events) {
    const destination = pins.get(node.id);
    if (!destination) continue;
    let currentFork: Fork | undefined;
    for (const id of node.parentIds) {
      const parent = nodes.get(id);
      const origin = pins.get(id);
      if (!parent || !origin) continue;
      childCounts.set(id, (childCounts.get(id) ?? 0) + 1);
      if (
        node.family !== "thread" &&
        node.family !== "target" &&
        parent.family !== "thread" &&
        parent.family !== "target" &&
        Math.abs(origin.x - destination.x) < 0.5
      ) {
        const kind =
          node.family === "suggestion"
            ? parent.family === "suggestion" && node.entityId === parent.entityId
              ? "revision"
              : "fork"
            : "causal";
        const key = `${kind}:${id}`;
        let fork = sideForks.get(key);
        if (!fork) {
          fork = { kind, origin: { id, ...origin }, children: [] };
          sideForks.set(key, fork);
        }
        fork.children.push({ id: node.id, ...destination });
        continue;
      }
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
          path:
            parent.family === "target" || parent.family === "thread"
              ? markerPath(origin, destination)
              : actionExitPath(origin, destination),
        });
      }
    }
    if (node.family === "suggestion") {
      lastFork = currentFork;
    }
  }

  const bracketed: SideFork[] = [];
  for (const fork of sideForks.values()) {
    const { origin, children, kind } = fork;
    const child = children[0]!;
    const intervening = events.some((node) => {
      if (
        node.id === origin.id ||
        node.id === child.id ||
        node.family === "thread" ||
        node.family === "target"
      )
        return false;
      const pin = pins.get(node.id);
      return (
        pin &&
        Math.abs(pin.x - origin.x) < 0.5 &&
        pin.y > Math.min(origin.y, child.y) &&
        pin.y < Math.max(origin.y, child.y)
      );
    });
    if (children.length === 1 && childCounts.get(origin.id) === 1 && !intervening) {
      wires.push({ kind, from: origin.id, to: child.id, path: markerPath(origin, child) });
    } else {
      bracketed.push(fork);
    }
  }
  // Each recorded parent owns a side bracket; intervening actions never become sequential links.
  const orderedSideForks = bracketed.sort(
    (a, b) =>
      Math.min(a.origin.y, ...a.children.map((child) => child.y)) -
      Math.min(b.origin.y, ...b.children.map((child) => child.y)),
  );
  const channelEnds: number[] = [];
  const sideChannels = orderedSideForks.map(({ origin, children }) => {
    const start = Math.min(origin.y, ...children.map((child) => child.y));
    const end = Math.max(origin.y, ...children.map((child) => child.y));
    const available = channelEnds.findIndex((previousEnd) => previousEnd < start);
    const channel = available < 0 ? channelEnds.length : available;
    channelEnds[channel] = end;
    return channel;
  });
  for (const [index, { origin, children, kind }] of orderedSideForks.entries()) {
    const gap = Math.max(
      0,
      Math.min(origin.railGap ?? 7, ...children.map((child) => child.railGap ?? 7)) - 6,
    );
    const offset =
      origin.radius + 5 + (gap * (sideChannels[index]! + 1)) / (channelEnds.length + 1);
    const stem = origin.x - offset;
    for (const child of children) {
      const direction = Math.sign(child.y - origin.y) || 1;
      const round = Math.min(3, offset / 2, Math.abs(child.y - origin.y) / 2);
      const path = [
        `M ${origin.x} ${origin.y}`,
        `H ${stem + round}`,
        `Q ${stem} ${origin.y} ${stem} ${origin.y + direction * round}`,
        `V ${child.y - direction * round}`,
        `Q ${stem} ${child.y} ${stem + round} ${child.y}`,
        `H ${child.x}`,
      ].join(" ");
      wires.push({ kind, from: origin.id, to: child.id, path });
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
