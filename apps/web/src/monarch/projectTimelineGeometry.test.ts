import { expect, it } from "vite-plus/test";

import {
  timelineWires,
  type TimelineMarkerPoint,
  type TimelineWire,
} from "./projectTimelineGeometry";

type Node = Parameters<typeof timelineWires>[0][number];
const node = (id: string, family: Node["family"], overrides: Partial<Node> = {}): Node => ({
  id,
  entityId: id,
  family,
  parentIds: [],
  ...overrides,
});
const pin = (x: number, y: number): TimelineMarkerPoint => ({
  x,
  y,
  rowTop: y - 22,
  rowBottom: y + 64,
  radius: 11,
  labelGap: 10,
  railGap: 7,
});
const pairs = (wires: readonly TimelineWire[]) =>
  [
    ...new Set(wires.flatMap(({ relations }) => relations.map(({ from, to }) => `${from}:${to}`))),
  ].sort();
const parsedPath = (wire: TimelineWire) => {
  const tokens = wire.path.split(/\s+/);
  const points: { x: number; y: number }[] = [];
  const lines: { ax: number; ay: number; bx: number; by: number }[] = [];
  let current = { x: 0, y: 0 };
  let length = 0;
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++];
    let control: { x: number; y: number } | null = null;
    if (command === "Q") control = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    const point = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    if (command === "L") {
      lines.push({ ax: current.x, ay: current.y, bx: point.x, by: point.y });
      length += Math.hypot(point.x - current.x, point.y - current.y);
    } else if (control) {
      let previous = current;
      for (let step = 1; step <= 80; step++) {
        const t = step / 80;
        const sample = {
          x: (1 - t) ** 2 * current.x + 2 * (1 - t) * t * control.x + t * t * point.x,
          y: (1 - t) ** 2 * current.y + 2 * (1 - t) * t * control.y + t * t * point.y,
        };
        length += Math.hypot(sample.x - previous.x, sample.y - previous.y);
        previous = sample;
      }
    }
    points.push(point);
    current = point;
  }
  return { points, lines, length };
};
const pathPoints = (wire: TimelineWire) => parsedPath(wire).points;
const segments = (wire: TimelineWire) => parsedPath(wire).lines;
function assertUniqueStrokes(wires: readonly TimelineWire[]) {
  expect(new Set(wires.map(({ key }) => key)).size).toBe(wires.length);
  const painted = wires.flatMap(segments);
  for (const [index, a] of painted.entries()) {
    for (const b of painted.slice(index + 1)) {
      const verticalOverlap =
        a.ax === a.bx &&
        b.ax === b.bx &&
        a.ax === b.ax &&
        Math.min(Math.max(a.ay, a.by), Math.max(b.ay, b.by)) >
          Math.max(Math.min(a.ay, a.by), Math.min(b.ay, b.by));
      const horizontalOverlap =
        a.ay === a.by &&
        b.ay === b.by &&
        a.ay === b.ay &&
        Math.min(Math.max(a.ax, a.bx), Math.max(b.ax, b.bx)) >
          Math.max(Math.min(a.ax, a.bx), Math.min(b.ax, b.bx));
      expect(verticalOverlap || horizontalOverlap).toBe(false);
    }
  }
}
function assertEndpoint(
  wires: readonly TimelineWire[],
  from: string,
  to: string,
  point: TimelineMarkerPoint,
) {
  const related = wires.filter(({ relations }) =>
    relations.some((relation) => relation.from === from && relation.to === to),
  );
  expect(
    related.some((wire) => pathPoints(wire).some(({ x, y }) => x === point.x && y === point.y)),
  ).toBe(true);
}

it("shows exact loaded outer associations, deduplicating parents and shared target strokes", () => {
  const events = [
    node("target-v1", "target", { entityId: "target" }),
    node("target-v2", "target", { entityId: "target" }),
    node("unrelated-target", "target"),
    node("work", "thread"),
    node("review", "model", {
      parentIds: ["target-v1"],
      relatedEventIds: ["target-v1", "target-v1", "missing"],
    }),
    node("proposal", "suggestion", { relatedEventIds: ["target-v1", "target-v2", "work"] }),
  ];
  const pins = new Map([
    ["target-v1", pin(62.5, 22)],
    ["target-v2", pin(62.5, 114)],
    ["unrelated-target", pin(62.5, 206)],
    ["work", pin(323.5, 114)],
    ["review", pin(191.5, 306)],
    ["proposal", pin(191.5, 398)],
  ]);
  const wires = timelineWires(events, pins);
  expect(pairs(wires)).toEqual([
    "target-v1:proposal",
    "target-v1:review",
    "target-v2:proposal",
    "work:proposal",
  ]);
  expect(wires.every(({ kind }) => kind === "source")).toBe(true);
  for (const [from, to] of [
    ["target-v1", "review"],
    ["target-v1", "proposal"],
    ["target-v2", "proposal"],
    ["work", "proposal"],
  ]) {
    assertEndpoint(wires, from!, to!, pins.get(from!)!);
    assertEndpoint(wires, from!, to!, pins.get(to!)!);
  }
  expect(wires.some(({ relations }) => relations.length > 1)).toBe(true);
  assertUniqueStrokes(wires);
});

it("retains genuine cross-midnight links without anchoring an absent source to a matching row", () => {
  const events = [
    node("source-turn", "thread", { at: "2026-11-05T22:59:00.000Z" }),
    node("other-turn", "thread", { at: "2026-11-06T08:00:00.000Z" }),
    node("journal", "model", { at: "2026-11-06T08:00:00.000Z", parentIds: ["source-turn"] }),
  ];
  const pins = new Map([
    ["source-turn", pin(323.5, 22)],
    ["other-turn", pin(323.5, 306)],
    ["journal", pin(191.5, 398)],
  ]);
  const wires = timelineWires(events, pins);
  expect(pairs(wires)).toEqual(["source-turn:journal"]);
  assertEndpoint(wires, "source-turn", "journal", pins.get("source-turn")!);
  assertEndpoint(wires, "source-turn", "journal", pins.get("journal")!);
  pins.delete("source-turn");
  expect(timelineWires(events, pins)).toEqual([]);
});

it("shows only the explicitly selected node's non-adjacent middle relationships on a shared focus branch", () => {
  const events = [
    node("review", "model"),
    node("unrelated", "model"),
    node("a", "suggestion", { parentIds: ["review"] }),
    node("b", "suggestion", { parentIds: ["review"] }),
  ];
  const pins = new Map([
    ["review", pin(191.5, 22)],
    ["unrelated", pin(191.5, 114)],
    ["a", pin(191.5, 306)],
    ["b", pin(191.5, 398)],
  ]);
  expect(timelineWires(events, pins)).toEqual([]);
  expect(timelineWires(events, pins, { selectedId: "unrelated" })).toEqual([]);
  const selectedChild = timelineWires(events, pins, { selectedId: "a" });
  expect(pairs(selectedChild)).toEqual(["review:a"]);
  expect(selectedChild.every(({ kind }) => kind === "focus")).toBe(true);
  const selectedParent = timelineWires(events, pins, { selectedId: "review" });
  expect(pairs(selectedParent)).toEqual(["review:a", "review:b"]);
  expect(selectedParent.some(({ relations }) => relations.length === 2)).toBe(true);
  assertUniqueStrokes(selectedParent);
});

it("keeps one adjacent real action step solid and preserves confirmed sent-link identity", () => {
  const suggested = node("suggested", "suggestion");
  const prepared = node("prepared", "suggestion", {
    entityId: "suggested",
    parentIds: ["suggested"],
  });
  const pins = new Map([
    ["suggested", pin(84, 22)],
    ["prepared", pin(84, 214)],
  ]);
  const adjacent = timelineWires([suggested, prepared], pins);
  expect(adjacent).toHaveLength(1);
  expect(adjacent[0]).toMatchObject({
    kind: "step",
    from: "suggested",
    to: "prepared",
    path: "M 84 22 L 84 214",
  });
  const unrelated = node("unrelated", "model");
  pins.set("unrelated", pin(84, 114));
  expect(timelineWires([suggested, unrelated, prepared], pins)).toEqual([]);
  const sent = node("sent", "thread", { parentIds: ["suggested"], relatedEventIds: ["suggested"] });
  pins.set("sent", pin(180, 306));
  const links = timelineWires([suggested, prepared, sent], pins);
  expect(pairs(links)).toEqual(["suggested:prepared", "suggested:sent"]);
  expect(links.some(({ kind }) => kind === "sent")).toBe(true);
  expect(links.some(({ kind }) => kind === "step")).toBe(true);
  assertEndpoint(links, "suggested", "sent", pins.get("suggested")!);
  assertEndpoint(links, "suggested", "sent", pins.get("sent")!);
  assertUniqueStrokes(links);
});

it("keeps outer-source routes out of middle captions for earlier and later source rows", () => {
  for (const actionX of [140, 220, 360]) {
    for (const sourceY of [22, 620]) {
      const source = pin(62.5, sourceY);
      const action = pin(actionX, 398);
      const unrelated = pin(actionX, 214);
      const events = [
        node("target", "target"),
        node("unrelated", "model"),
        node("action", "model", { relatedEventIds: ["target"] }),
      ];
      const wires = timelineWires(
        events,
        new Map([
          ["target", source],
          ["unrelated", unrelated],
          ["action", action],
        ]),
      );
      expect(wires.some(({ path }) => path.includes(" Q "))).toBe(true);
      for (const { ax, ay, bx, by } of wires.flatMap(segments)) {
        const crossesCaption =
          Math.max(ax, bx) > actionX + unrelated.radius + unrelated.labelGap &&
          Math.min(ax, bx) < actionX + 100 &&
          Math.max(ay, by) > unrelated.rowTop + 12 &&
          Math.min(ay, by) < unrelated.rowBottom - 12;
        expect(crossesCaption).toBe(false);
      }
      assertEndpoint(wires, "target", "action", source);
      assertEndpoint(wires, "target", "action", action);
      assertUniqueStrokes(wires);
    }
  }
});

it("uses inward six-pixel source channels and marks space-limited overview aggregation", () => {
  const events = [
    node("t1", "target"),
    node("t2", "target"),
    node("t3", "target"),
    node("a1", "model", { relatedEventIds: ["t1"] }),
    node("a2", "model", { relatedEventIds: ["t2"] }),
    node("a3", "model", { relatedEventIds: ["t3"] }),
  ];
  const pins = new Map([
    ["t1", { ...pin(62.5, 22), railGap: 22 }],
    ["t2", { ...pin(62.5, 114), railGap: 22 }],
    ["t3", { ...pin(62.5, 206), railGap: 22 }],
    ["a1", { ...pin(191.5, 398), railGap: 22 }],
    ["a2", { ...pin(191.5, 490), railGap: 22 }],
    ["a3", { ...pin(191.5, 582), railGap: 22 }],
  ]);
  const overview = timelineWires(events, pins);
  for (const { ax, bx } of overview.flatMap(segments)) {
    expect(Math.min(ax, bx)).toBeGreaterThanOrEqual(62.5);
  }
  expect(overview.some((wire) => wire.aggregate)).toBe(true);
  expect(pairs(overview)).toEqual(["t1:a1", "t2:a2", "t3:a3"]);
  const selected = timelineWires(events, pins, { selectedId: "t2" });
  expect(pairs(selected)).toEqual(["t2:a2"]);
  expect(selected.every((wire) => !wire.aggregate)).toBe(true);
});

it("paints an explicit project scope tap and selected focus shoulder only once", () => {
  const events = [
    node("review", "model", { projectScope: true }),
    node("a", "suggestion", { parentIds: ["review"] }),
    node("b", "suggestion", { parentIds: ["review"] }),
  ];
  const pins = new Map([
    ["review", pin(191.5, 22)],
    ["a", pin(191.5, 214)],
    ["b", pin(191.5, 306)],
  ]);
  const wires = timelineWires(events, pins, { selectedId: "review", projectRailX: 62.5 });
  expect(pairs(wires)).toEqual(["project-scope:review", "review:a", "review:b"]);
  expect(wires.some(({ kind }) => kind === "scope")).toBe(true);
  assertUniqueStrokes(wires);
});

it("gaps an unrelated target channel at a project-scope crossover while preserving real taps", () => {
  const events = [
    node("target", "target"),
    node("manual", "model", { projectScope: true }),
    node("proposal", "suggestion", { relatedEventIds: ["target"] }),
  ];
  const pins = new Map([
    ["target", { ...pin(62.5, 22), railGap: 22 }],
    ["manual", { ...pin(191.5, 214), railGap: 22 }],
    ["proposal", { ...pin(191.5, 398), railGap: 22 }],
  ]);
  const wires = timelineWires(events, pins, { projectRailX: 62.5 });
  const crossingX = 191.5 - 11 - 9;
  const crosses = wires
    .flatMap(segments)
    .some(
      ({ ax, ay, bx, by }) =>
        ax === crossingX && bx === crossingX && Math.min(ay, by) < 214 && Math.max(ay, by) > 214,
    );
  expect(crosses).toBe(false);
  expect(
    wires
      .filter(({ kind }) => kind === "scope")
      .flatMap(segments)
      .some(
        ({ ax, ay, bx, by }) =>
          ay === 214 && by === 214 && Math.min(ax, bx) < crossingX && Math.max(ax, bx) > crossingX,
      ),
  ).toBe(true);
  assertEndpoint(wires, "target", "proposal", pins.get("target")!);
  assertEndpoint(wires, "target", "proposal", pins.get("proposal")!);
  const targetPieces = wires.filter(({ relations }) =>
    relations.some(({ from, to }) => from === "target" && to === "proposal"),
  );
  const before = targetPieces.find((wire) => {
    const point = pathPoints(wire).at(-1)!;
    return point.x === crossingX && point.y === 211;
  });
  const after = targetPieces.find((wire) => {
    const point = pathPoints(wire)[0]!;
    return point.x === crossingX && point.y === 217;
  });
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(after!.dashOffset).toBeCloseTo(before!.dashOffset + parsedPath(before!).length + 6, 2);
  assertUniqueStrokes(wires);
});

it("keeps an adjacent result connected to its own review even when the review has another child", () => {
  const events = [
    node("start", "model", { entityId: "review" }),
    node("result", "model", { entityId: "review", parentIds: ["start"] }),
    node("proposal", "suggestion", { parentIds: ["start"] }),
  ];
  const pins = new Map([
    ["start", pin(191.5, 22)],
    ["result", pin(191.5, 114)],
    ["proposal", pin(191.5, 306)],
  ]);
  const wires = timelineWires(events, pins);
  expect(pairs(wires)).toEqual(["start:result"]);
  expect(wires[0]).toMatchObject({ kind: "step", path: "M 191.5 22 L 191.5 114" });
});
