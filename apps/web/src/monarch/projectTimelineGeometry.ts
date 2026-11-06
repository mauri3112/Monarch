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
type Node = Pick<MonarchTimelineEvent, "id" | "entityId" | "family" | "parentIds"> &
  Partial<
    Pick<MonarchTimelineEvent, "relatedEventIds" | "projectScope" | "at" | "state" | "entityKind">
  >;
export interface TimelineRelation {
  from: string;
  to: string;
}
export interface TimelineWire extends TimelineRelation {
  key: string;
  kind: "source" | "sent" | "step" | "focus" | "scope";
  path: string;
  relations: readonly TimelineRelation[];
  outerEventIds: readonly string[];
  aggregate?: true;
  dashOffset: number;
}
type Kind = TimelineWire["kind"];
type Link = TimelineRelation & { kind: Kind };
type Stroke = Link & { points: readonly Point[]; outerId?: string; aggregate?: boolean };

const outer = (node: Node) => node.family === "target" || node.family === "thread";
const pairKey = (from: string, to: string) => JSON.stringify([from, to].sort());
const relationKey = ({ from, to }: TimelineRelation) => JSON.stringify([from, to]);
const rounded = (value: number) => Math.round(value * 1000) / 1000;
function strokeKind(strokes: readonly Stroke[]): Kind {
  if (strokes.every(({ kind }) => kind === "sent")) return "sent";
  if (strokes.some(({ kind }) => kind === "sent" || kind === "source")) return "source";
  if (strokes.some(({ kind }) => kind === "scope")) return "scope";
  return strokes.some(({ kind }) => kind === "focus") ? "focus" : "step";
}

type Painted = Omit<TimelineWire, "path" | "key"> & { points: readonly Point[] };
const pointKey = (point: Point) => `${point.x}:${point.y}`;

type PhaseGap = { from: string; to: string; length: number };

/** Unrelated crossing lines do not form a junction: leave a small gap in the vertical stroke. */
function separatedCrossings(pieces: readonly Painted[], markedEndpoints: ReadonlySet<string>) {
  const output: Painted[] = [];
  const gaps: PhaseGap[] = [];
  for (const piece of pieces) {
    const start = piece.points[0]!;
    const end = piece.points.at(-1)!;
    if (start.x !== end.x) {
      output.push(piece);
      continue;
    }
    const low = Math.min(start.y, end.y);
    const high = Math.max(start.y, end.y);
    const breaks: { low: number; high: number }[] = [];
    for (const other of pieces) {
      const a = other.points[0]!;
      const b = other.points.at(-1)!;
      if (
        a.y !== b.y ||
        a.y <= low + 0.5 ||
        a.y >= high - 0.5 ||
        start.x <= Math.min(a.x, b.x) + 0.5 ||
        start.x >= Math.max(a.x, b.x) - 0.5 ||
        markedEndpoints.has(pointKey({ x: start.x, y: a.y }))
      )
        continue;
      const related = piece.relations.some((own) =>
        other.relations.some(
          (relation) =>
            own.from === relation.from ||
            own.from === relation.to ||
            own.to === relation.from ||
            own.to === relation.to,
        ),
      );
      if (related) continue;
      const radius = Math.min(3, (a.y - low) / 2, (high - a.y) / 2);
      breaks.push({ low: rounded(a.y - radius), high: rounded(a.y + radius) });
    }
    if (!breaks.length) {
      output.push(piece);
      continue;
    }
    breaks.sort((a, b) => a.low - b.low);
    const merged: typeof breaks = [];
    for (const gap of breaks) {
      const previous = merged.at(-1);
      if (previous && previous.high >= gap.low) previous.high = Math.max(previous.high, gap.high);
      else merged.push({ ...gap });
    }
    const intervals: { low: number; high: number }[] = [];
    let cursor = low;
    for (const gap of merged) {
      if (gap.low > cursor) intervals.push({ low: cursor, high: gap.low });
      const forward = start.y < end.y;
      gaps.push({
        from: pointKey({ x: start.x, y: forward ? gap.low : gap.high }),
        to: pointKey({ x: start.x, y: forward ? gap.high : gap.low }),
        length: gap.high - gap.low,
      });
      cursor = gap.high;
    }
    if (cursor < high) intervals.push({ low: cursor, high });
    if (start.y > end.y) intervals.reverse();
    for (const interval of intervals) {
      const first = start.y < end.y ? interval.low : interval.high;
      const last = start.y < end.y ? interval.high : interval.low;
      output.push({
        ...piece,
        dashOffset: piece.dashOffset + Math.abs(first - start.y),
        points: [
          { x: start.x, y: first },
          { x: start.x, y: last },
        ],
      });
    }
  }
  return { pieces: output, gaps };
}

function roundedPolyline(points: readonly Point[], protectedPoints: ReadonlySet<string>) {
  const commands = [`M ${points[0]!.x} ${points[0]!.y}`];
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    length += Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
    const next = points[index + 1];
    if (
      !next ||
      protectedPoints.has(pointKey(point)) ||
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    ) {
      commands.push(`L ${point.x} ${point.y}`);
      continue;
    }
    const incoming = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
    const outgoing = Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2);
    const entry = {
      x: rounded(point.x - Math.sign(point.x - previous.x) * radius),
      y: rounded(point.y - Math.sign(point.y - previous.y) * radius),
    };
    const exit = {
      x: rounded(point.x + Math.sign(next.x - point.x) * radius),
      y: rounded(point.y + Math.sign(next.y - point.y) * radius),
    };
    commands.push(`L ${entry.x} ${entry.y} Q ${point.x} ${point.y} ${exit.x} ${exit.y}`);
    // Exact arc-length reduction of this right-angle quadratic corner.
    length -= (1 - Math.asinh(1) / Math.SQRT2) * radius;
  }
  return { path: commands.join(" "), length };
}

/** Rejoin unbranched pieces so dotted elbows keep one continuous dash phase. */
function joinedStrokes(
  pieces: readonly Painted[],
  markedEndpoints: ReadonlySet<string>,
  phaseGaps: readonly PhaseGap[],
): TimelineWire[] {
  const buckets = new Map<string, Painted[]>();
  const neighbors = new Map<string, Set<string>>();
  for (const piece of pieces) {
    const signature = JSON.stringify([
      piece.kind,
      piece.relations,
      piece.outerEventIds,
      piece.aggregate,
    ]);
    const bucket = buckets.get(signature);
    if (bucket) bucket.push(piece);
    else buckets.set(signature, [piece]);
    for (const [a, b] of [
      [piece.points[0]!, piece.points.at(-1)!],
      [piece.points.at(-1)!, piece.points[0]!],
    ]) {
      const key = pointKey(a!);
      let adjacent = neighbors.get(key);
      if (!adjacent) {
        adjacent = new Set();
        neighbors.set(key, adjacent);
      }
      adjacent.add(pointKey(b!));
    }
  }
  const protectedPoints = new Set(markedEndpoints);
  for (const [key, adjacent] of neighbors) if (adjacent.size !== 2) protectedPoints.add(key);
  const chains: { wire: TimelineWire; start: string; end: string; length: number }[] = [];
  for (const bucket of buckets.values()) {
    const remaining = new Set(bucket);
    for (const initial of bucket) {
      if (!remaining.delete(initial)) continue;
      const points = [...initial.points];
      let dashOffset = initial.dashOffset;
      let joined = true;
      while (joined) {
        joined = false;
        const after = [...remaining].filter(
          (piece) => pointKey(piece.points[0]!) === pointKey(points.at(-1)!),
        );
        if (after.length === 1) {
          remaining.delete(after[0]!);
          points.push(...after[0]!.points.slice(1));
          joined = true;
        }
        const before = [...remaining].filter(
          (piece) => pointKey(piece.points.at(-1)!) === pointKey(points[0]!),
        );
        if (before.length === 1) {
          remaining.delete(before[0]!);
          points.unshift(...before[0]!.points.slice(0, -1));
          dashOffset = before[0]!.dashOffset;
          joined = true;
        }
      }
      const { path, length } = roundedPolyline(points, protectedPoints);
      const { points: _points, ...metadata } = initial;
      chains.push({
        wire: { ...metadata, dashOffset, key: `${initial.kind}:${path}`, path },
        start: pointKey(points[0]!),
        end: pointKey(points.at(-1)!),
        length,
      });
    }
  }
  // Continue the actual rounded arc length through split branch pieces.
  const starts = new Map<string, number[]>();
  for (const [index, chain] of chains.entries()) {
    const incoming = starts.get(chain.start);
    if (incoming) incoming.push(index);
    else starts.set(chain.start, [index]);
  }
  const gapStarts = new Map<string, PhaseGap[]>();
  for (const gap of phaseGaps) {
    const following = gapStarts.get(gap.from);
    if (following) following.push(gap);
    else gapStarts.set(gap.from, [gap]);
  }
  const visited = new Set<number>();
  const queue = chains.flatMap(({ wire }, index) => (wire.dashOffset === 0 ? [index] : []));
  for (const index of queue) visited.add(index);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const chain = chains[queue[cursor]!]!;
    const continuations = [{ to: chain.end, length: 0 }, ...(gapStarts.get(chain.end) ?? [])];
    for (const continuation of continuations) {
      for (const index of starts.get(continuation.to) ?? []) {
        if (visited.has(index)) continue;
        visited.add(index);
        chains[index]!.wire.dashOffset = chain.wire.dashOffset + chain.length + continuation.length;
        queue.push(index);
      }
    }
  }
  return chains.map(({ wire }) => wire);
}

/** Split collinear overlaps once, retaining all actual relationships and their arc-length phase. */
function uniqueStrokes(strokes: readonly Stroke[]): TimelineWire[] {
  type Segment = {
    start: number;
    end: number;
    before: number;
    forward: boolean;
    distance: number;
    stroke: Stroke;
  };
  const lines = new Map<string, { horizontal: boolean; fixed: number; segments: Segment[] }>();
  for (const stroke of strokes) {
    let distance = 0;
    for (let index = 1; index < stroke.points.length; index++) {
      const before = stroke.points[index - 1]!;
      const after = stroke.points[index]!;
      const horizontal = Math.abs(before.y - after.y) < 0.001;
      const fixed = rounded(horizontal ? before.y : before.x);
      const beforeAxis = rounded(horizontal ? before.x : before.y);
      const afterAxis = rounded(horizontal ? after.x : after.y);
      const start = Math.min(beforeAxis, afterAxis);
      const end = Math.max(beforeAxis, afterAxis);
      if (end <= start) continue;
      const key = `${horizontal ? "h" : "v"}:${fixed}`;
      let line = lines.get(key);
      if (!line) {
        line = { horizontal, fixed, segments: [] };
        lines.set(key, line);
      }
      line.segments.push({
        start,
        end,
        before: beforeAxis,
        forward: afterAxis > beforeAxis,
        distance,
        stroke,
      });
      distance += end - start;
    }
  }
  const pieces: Painted[] = [];
  for (const { horizontal, fixed, segments } of lines.values()) {
    const cuts = [...new Set(segments.flatMap(({ start, end }) => [start, end]))].sort(
      (a, b) => a - b,
    );
    for (let index = 1; index < cuts.length; index++) {
      const start = cuts[index - 1]!;
      const end = cuts[index]!;
      const covering = segments.filter((segment) => segment.start <= start && segment.end >= end);
      if (!covering.length) continue;
      const kind = strokeKind(covering.map(({ stroke }) => stroke));
      const representative = covering.find(({ stroke }) => stroke.kind === kind) ?? covering[0]!;
      const relations = [
        ...new Map(
          covering.map(({ stroke }) => [relationKey(stroke), { from: stroke.from, to: stroke.to }]),
        ).values(),
      ].sort((a, b) => relationKey(a).localeCompare(relationKey(b)));
      const outerEventIds = [
        ...new Set(covering.flatMap(({ stroke }) => (stroke.outerId ? [stroke.outerId] : []))),
      ].sort();
      const first = representative.forward ? start : end;
      const last = representative.forward ? end : start;
      pieces.push({
        ...relations[0]!,
        relations,
        outerEventIds,
        kind,
        ...(covering.some(({ stroke }) => stroke.aggregate) ? { aggregate: true as const } : {}),
        dashOffset: representative.distance + Math.abs(first - representative.before),
        points: horizontal
          ? [
              { x: first, y: fixed },
              { x: last, y: fixed },
            ]
          : [
              { x: fixed, y: first },
              { x: fixed, y: last },
            ],
      });
    }
  }
  const markedEndpoints = new Set(
    strokes.flatMap(({ points }) => [pointKey(points[0]!), pointKey(points.at(-1)!)]),
  );
  const separated = separatedCrossings(pieces, markedEndpoints);
  return joinedStrokes(separated.pieces, markedEndpoints, separated.gaps);
}

export function timelineWires(
  events: readonly Node[],
  pins: ReadonlyMap<string, TimelineMarkerPoint>,
  {
    selectedId,
    projectRailX,
  }: {
    selectedId?: string | null | undefined;
    projectRailX?: number | undefined;
  } = {},
): TimelineWire[] {
  const nodes = new Map(events.map((node) => [node.id, node]));
  const cross = new Map<string, Link>();
  const middle = new Map<string, Link>();
  const childCounts = new Map<string, number>();
  for (const node of events) {
    const pin = pins.get(node.id);
    if (!pin) continue;
    for (const parentId of new Set(node.parentIds)) {
      const parent = nodes.get(parentId);
      const parentPin = pins.get(parentId);
      if (!parent || !parentPin || parentId === node.id) continue;
      childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
      const link: Link = {
        from: parentId,
        to: node.id,
        kind: parent.family === "suggestion" && node.family === "thread" ? "sent" : "source",
      };
      if (!outer(parent) && !outer(node)) {
        middle.set(pairKey(parentId, node.id), link);
      } else if (Math.abs(parentPin.x - pin.x) >= 0.5) {
        cross.set(pairKey(parentId, node.id), link);
      }
    }
    for (const relatedId of new Set(node.relatedEventIds ?? [])) {
      const related = nodes.get(relatedId);
      if (!related || !pins.has(relatedId) || outer(related) === outer(node)) continue;
      const key = pairKey(relatedId, node.id);
      if (!cross.has(key))
        cross.set(key, {
          from: outer(related) ? relatedId : node.id,
          to: outer(related) ? node.id : relatedId,
          kind: "source",
        });
    }
  }

  const strokes: Stroke[] = [];
  if (projectRailX !== undefined) {
    for (const node of events) {
      const point = pins.get(node.id);
      if (node.projectScope && point)
        strokes.push({
          from: "project-scope",
          to: node.id,
          kind: "scope",
          points: [{ x: projectRailX, y: point.y }, point],
        });
    }
  }
  for (const link of middle.values()) {
    const source = pins.get(link.from)!;
    const destination = pins.get(link.to)!;
    const intervening = events.some((node) => {
      if (outer(node) || node.id === link.from || node.id === link.to) return false;
      const pin = pins.get(node.id);
      return (
        pin &&
        Math.abs(pin.x - source.x) < 0.5 &&
        pin.y > Math.min(source.y, destination.y) &&
        pin.y < Math.max(source.y, destination.y)
      );
    });
    const sourceNode = nodes.get(link.from)!;
    const destinationNode = nodes.get(link.to)!;
    const sameEntity =
      sourceNode.family === destinationNode.family &&
      sourceNode.entityId === destinationNode.entityId &&
      sourceNode.entityKind === destinationNode.entityKind;
    if (
      (childCounts.get(link.from) === 1 || sameEntity) &&
      !intervening &&
      Math.abs(source.x - destination.x) < 0.5
    ) {
      strokes.push({ ...link, kind: "step", points: [source, destination] });
    } else if (selectedId === link.from || selectedId === link.to) {
      const selected = pins.get(selectedId)!;
      const channel = selected.x - selected.radius - 3;
      strokes.push({
        ...link,
        kind: "focus",
        points: [
          source,
          { x: channel, y: source.y },
          { x: channel, y: destination.y },
          destination,
        ],
      });
    }
  }

  type Routed = {
    link: Link;
    origin: TimelineMarkerPoint;
    outerId: string;
    destination: TimelineMarkerPoint;
    destinationNode: Node;
    project: boolean;
  };
  type SourceGroup = {
    id: string;
    routes: Routed[];
    start: number;
    end: number;
    slot: number;
    aggregate: boolean;
  };
  const gutters = new Map<
    number,
    { rightPin: TimelineMarkerPoint; origins: Map<string, SourceGroup> }
  >();
  for (const link of cross.values()) {
    const from = nodes.get(link.from)!;
    const outerId = outer(from) ? link.from : link.to;
    const destinationId = outerId === link.from ? link.to : link.from;
    const origin = pins.get(outerId)!;
    const destination = pins.get(destinationId)!;
    const project = nodes.get(outerId)!.family === "target";
    const rightPin = project ? destination : origin;
    const key = rounded(rightPin.x);
    let gutter = gutters.get(key);
    if (!gutter) {
      gutter = { rightPin, origins: new Map() };
      gutters.set(key, gutter);
    }
    let group = gutter.origins.get(outerId);
    if (!group) {
      group = {
        id: outerId,
        routes: [],
        start: origin.y,
        end: origin.y,
        slot: -1,
        aggregate: false,
      };
      gutter.origins.set(outerId, group);
    }
    group.start = Math.min(group.start, destination.y);
    group.end = Math.max(group.end, destination.y);
    group.routes.push({
      link,
      origin,
      outerId,
      destination,
      destinationNode: nodes.get(destinationId)!,
      project,
    });
  }
  const allocate = (groups: SourceGroup[]) => {
    const ends: number[] = [];
    for (const group of groups) {
      const available = ends.findIndex((previous) => previous < group.start);
      group.slot = available < 0 ? ends.length : available;
      ends[group.slot] = group.end;
    }
    return ends.length;
  };
  for (const { rightPin, origins } of gutters.values()) {
    const capacity = Math.max(1, Math.floor(((rightPin.railGap ?? 7) - 12) / 6) + 1);
    let groups = [...origins.values()].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    );
    if (
      allocate(groups) > capacity &&
      selectedId &&
      groups.some(({ routes }) =>
        routes.some(({ link }) => link.from === selectedId || link.to === selectedId),
      )
    ) {
      groups = groups.flatMap((group) => {
        const routes = group.routes.filter(
          ({ link }) => link.from === selectedId || link.to === selectedId,
        );
        return routes.length ? [{ ...group, routes }] : [];
      });
      allocate(groups);
    }
    for (const group of groups) {
      if (group.slot >= capacity) group.aggregate = true;
      group.slot = Math.min(group.slot, capacity - 1);
    }
    for (const group of groups) {
      if (
        groups.some(
          (other) =>
            other !== group &&
            other.slot === group.slot &&
            other.start <= group.end &&
            other.end >= group.start &&
            other.aggregate,
        )
      )
        group.aggregate = true;
      const channel = rightPin.x - rightPin.radius - 9 - group.slot * 6;
      for (const { link, origin, outerId, destination, destinationNode, project } of group.routes) {
        const sourceBoundary = origin.y < destination.y ? origin.rowBottom : origin.rowTop;
        const destinationBoundary =
          origin.y < destination.y ? destination.rowTop : destination.rowBottom;
        const points: Point[] = [origin];
        if (project) {
          const exit = origin.x + origin.radius + origin.labelGap / 2;
          points.push(
            { x: exit, y: origin.y },
            { x: exit, y: sourceBoundary },
            { x: channel, y: sourceBoundary },
          );
        } else points.push({ x: channel, y: origin.y });
        if (destinationNode.family === "thread") {
          points.push({ x: channel, y: destination.y }, destination);
        } else if (destinationNode.family === "target") {
          const entry = destination.x + destination.radius + destination.labelGap / 2;
          points.push(
            { x: channel, y: destinationBoundary },
            { x: entry, y: destinationBoundary },
            { x: entry, y: destination.y },
            destination,
          );
        } else if (project) {
          points.push({ x: channel, y: destination.y }, destination);
        } else {
          const entry = destination.x + destination.radius + destination.labelGap / 2;
          points.push(
            { x: channel, y: destinationBoundary },
            { x: entry, y: destinationBoundary },
            { x: entry, y: destination.y },
            destination,
          );
        }
        strokes.push({ ...link, outerId, aggregate: group.aggregate, points });
      }
    }
  }
  return uniqueStrokes(strokes);
}
