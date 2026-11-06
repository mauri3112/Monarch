import { expect, it } from "vite-plus/test";

import { timelineWires, type TimelineMarkerPoint } from "./projectTimelineGeometry";

const review: TimelineMarkerPoint = {
  x: 62.5,
  y: 22,
  rowTop: 0,
  rowBottom: 86,
  radius: 11,
  labelGap: 10,
};
const proposal: TimelineMarkerPoint = {
  x: 191.5,
  y: 214,
  rowTop: 188,
  rowBottom: 276,
  radius: 11,
  labelGap: 10,
};

const offer = [
  { id: "review", entityId: "run", family: "model", parentIds: [] },
  { id: "offer", entityId: "proposal", family: "suggestion", parentIds: ["review"] },
] as const;

it("leaves and enters on the marker axes and crosses only once in the reserved row gap", () => {
  const pins = new Map([
    ["review", review],
    ["offer", proposal],
  ]);
  expect(timelineWires(offer, pins)[0]?.path).toBe(
    "M 62.5 22 V 172 Q 62.5 188 78.5 188 H 175.5 Q 191.5 188 191.5 204 V 214",
  );
});

it("gives sibling proposals a shared fork and a sent thread a dotted route from its actual proposal", () => {
  const events = [
    { id: "review", entityId: "review", family: "model", parentIds: [] },
    { id: "a", entityId: "a", family: "suggestion", parentIds: ["review"] },
    { id: "b", entityId: "b", family: "suggestion", parentIds: ["review"] },
    { id: "a2", entityId: "a", family: "suggestion", parentIds: ["a"] },
    { id: "sent-b", entityId: "thread", family: "thread", parentIds: ["b"] },
  ] as const;
  const pins = new Map([
    ["review", { ...review, x: proposal.x }],
    ["a", proposal],
    ["b", { ...proposal, y: 306, rowTop: 280, rowBottom: 368 }],
    ["a2", { ...proposal, y: 396, rowTop: 370, rowBottom: 458 }],
    ["sent-b", { ...proposal, x: 323.5, y: 486, rowTop: 460, rowBottom: 548 }],
  ]);
  const links = timelineWires(events, pins);
  expect(links.map(({ kind, from, to }) => [kind, from, to])).toEqual([
    ["fork", "review", "a"],
    ["fork", "review", "b"],
    ["revision", "a", "a2"],
    ["sent", "b", "sent-b"],
  ]);
  expect(links.find((wire) => wire.kind === "sent")!.path).toBe(
    "M 191.5 306 Q 207.5 306 207.5 322 V 444 Q 207.5 460 223.5 460 H 307.5 Q 323.5 460 323.5 476 V 486",
  );
});

it("rounds upward branches and keeps revisions tied to their recorded parent", () => {
  const pins = new Map([
    ["review", proposal],
    ["offer", review],
  ]);
  expect(timelineWires([...offer].reverse(), pins)[0]?.path).toBe(
    "M 191.5 214 V 102 Q 191.5 86 175.5 86 H 78.5 Q 62.5 86 62.5 70 V 22",
  );
  pins.set("edit", { ...proposal, x: review.x });
  const edit = { ...offer[1], id: "edit", parentIds: ["offer"] };
  expect(
    timelineWires([...offer, edit], pins).find((wire) => wire.kind === "revision"),
  ).toMatchObject({
    from: "offer",
    to: "edit",
  });
});

it("centers one adjacent Actions relationship but brackets intervening actions and siblings", () => {
  const suggested = {
    id: "suggested",
    entityId: "proposal",
    family: "suggestion",
    parentIds: [],
  } as const;
  const prepared = { ...suggested, id: "prepared", parentIds: ["suggested"] } as const;
  const pins = new Map<string, TimelineMarkerPoint>([
    ["suggested", { ...review, x: 84, railGap: 7 }],
    ["prepared", { ...proposal, x: 84, railGap: 7 }],
  ]);
  expect(timelineWires([suggested, prepared], pins)[0]?.path).toBe("M 84 22 V 214");

  const unrelated = {
    id: "unrelated",
    entityId: "journal",
    family: "model",
    parentIds: [],
  } as const;
  pins.set("unrelated", { ...review, x: 84, y: 108, rowTop: 86, rowBottom: 174, railGap: 7 });
  const bracket = timelineWires([suggested, unrelated, prepared], pins)[0];
  expect(bracket).toMatchObject({ from: "suggested", to: "prepared" });
  expect(bracket?.path).toMatch(/^M 84 22 H /);

  const sibling = { ...prepared, id: "sibling", entityId: "other" };
  pins.set("sibling", { ...proposal, x: 84, y: 306, rowTop: 280, rowBottom: 368, railGap: 7 });
  const forks = timelineWires([suggested, prepared, sibling], pins);
  expect(forks).toHaveLength(2);
  expect(forks.every((wire) => wire.from === "suggested" && /^M 84 22 H /.test(wire.path))).toBe(
    true,
  );

  const sent = {
    id: "sent",
    entityId: "thread",
    family: "thread",
    parentIds: ["suggested"],
  } as const;
  pins.set("sent", { ...proposal, x: 180, y: 306, rowTop: 280, rowBottom: 368, railGap: 7 });
  const withSend = timelineWires([suggested, prepared, sent], pins);
  expect(withSend.find((wire) => wire.kind === "revision")?.path).toMatch(/^M 84 22 H /);
  expect(withSend.find((wire) => wire.kind === "sent")).toMatchObject({
    from: "suggested",
    to: "sent",
  });
});
