import type { MonarchTimelineEvent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { selectTimelineEvent } from "./projectTimelineSelection";

const event = (overrides: Partial<MonarchTimelineEvent>): MonarchTimelineEvent => ({
  id: "event",
  family: "schedule",
  entityKind: "prompt-schedule",
  entityId: "schedule",
  action: "updated",
  title: "Same title",
  detail: "",
  at: null,
  state: "recorded",
  parentIds: [],
  threadId: null,
  runId: null,
  ...overrides,
});

it("resolves owning entities and separates the next occurrence from the last run", () => {
  const oldRun = event({
    id: "old",
    at: "2026-11-04T09:00:00.000Z",
    runId: "run-1",
    state: "finished",
  });
  const lastRun = event({
    id: "last",
    at: "2026-11-05T09:00:00.000Z",
    runId: "run-2",
    state: "failed",
  });
  const next = event({ id: "next", at: "2026-11-06T09:00:00.000Z", state: "upcoming" });
  const unrelated = event({
    id: "different-kind",
    entityKind: "review-schedule",
    state: "running",
  });
  const events = [oldRun, unrelated, next, lastRun];
  const selection = { entityKind: "prompt-schedule", entityId: "schedule" } as const;
  expect(selectTimelineEvent(events, selection)?.id).toBe("next");
  expect(selectTimelineEvent(events, { ...selection, occurrence: "last" })?.id).toBe("last");
  expect(selectTimelineEvent(events, { ...selection, occurrence: "next" })?.id).toBe("next");
  expect(selectTimelineEvent([oldRun, lastRun], { ...selection, occurrence: "next" })).toBeNull();
  expect(selectTimelineEvent(events, { ...selection, eventId: unrelated.id })).toBeNull();
  expect(selectTimelineEvent(events, { ...selection, eventId: oldRun.id })?.id).toBe("old");
  const attention = event({
    id: "attention",
    entityKind: "thread",
    state: "needs-input",
    at: "2026-11-04T09:00:00.000Z",
  });
  const working = event({
    id: "working",
    entityKind: "thread",
    state: "running",
    at: "2026-11-05T09:00:00.000Z",
  });
  expect(
    selectTimelineEvent([working, attention], { entityKind: "thread", entityId: "schedule" })?.id,
  ).toBe("attention");
  const paused = event({ id: "paused", state: "paused" });
  expect(selectTimelineEvent([lastRun, paused], selection)?.id).toBe("paused");
});
