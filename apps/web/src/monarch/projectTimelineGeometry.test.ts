import { expect, it } from "vite-plus/test";

import { timelineConnectionPoints } from "./projectTimelineGeometry";

it("routes a review to its proposal without crossing intervening review captions", () => {
  for (const scale of [0.8, 1, 1.4]) {
    for (const proposalX of [140, 220, 360]) {
      const source = { x: 60, y: 22, rowTop: 0 };
      const destination = { x: proposalX, y: 202 * scale, rowTop: 180 * scale };
      const points = timelineConnectionPoints(source, destination);
      const caption = { left: 79, right: proposalX - 30, top: 108 * scale, bottom: 160 * scale };
      for (let index = 1; index < points.length; index++) {
        const before = points[index - 1]!;
        const after = points[index]!;
        const crossesCaption =
          Math.max(before.x, after.x) > caption.left &&
          Math.min(before.x, after.x) < caption.right &&
          Math.max(before.y, after.y) > caption.top &&
          Math.min(before.y, after.y) < caption.bottom;
        expect(crossesCaption).toBe(false);
      }
      expect(points[0]).toEqual(source);
      expect(points.at(-1)).toEqual(destination);
    }
  }
});

it("keeps same-lane history on its marker centers and supports upward sent links", () => {
  const source = { x: 60, y: 22, rowTop: 0 };
  const sameLane = { x: 60, y: 302, rowTop: 280 };
  const sameLanePoints = timelineConnectionPoints(source, sameLane);
  expect(sameLanePoints.every((point) => point.x === 60)).toBe(true);
  const sent = timelineConnectionPoints({ x: 260, y: 302, rowTop: 280 }, source);
  expect(sent[0]).toMatchObject({ x: 260, y: 302 });
  expect(sent.at(-1)).toEqual(source);
  expect(sent.some((point) => point.y > 22 && point.x > 60 && point.x < 246)).toBe(false);
});
