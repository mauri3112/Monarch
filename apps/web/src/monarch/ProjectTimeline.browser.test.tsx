import { ProjectId, type MonarchTimelineEvent } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectTimeline } from "./ProjectTimeline";
import "../index.css";

const event = (overrides: Partial<MonarchTimelineEvent>): MonarchTimelineEvent => ({
  id: "created",
  entityKind: "thread",
  entityId: "recovery",
  family: "thread",
  action: "Thread started",
  title: "Check recovery",
  detail: "",
  at: "2026-11-06T09:00:00.000Z",
  state: "ready",
  parentIds: [],
  threadId: null,
  runId: null,
  ...overrides,
});

it("navigates history by keyboard and returns to input needed before upcoming work", async () => {
  const events = [
    event({}),
    event({
      id: "attention",
      action: "Awaiting input",
      state: "needs-input",
      at: "2026-11-06T09:01:00.000Z",
      parentIds: ["created"],
    }),
    event({
      id: "upcoming",
      entityKind: "prompt-schedule",
      entityId: "smoke",
      family: "schedule",
      action: "Run a prompt",
      title: "Mac smoke checks",
      state: "upcoming",
      at: "2026-11-07T09:00:00.000Z",
    }),
  ];
  await using screen = await render(
    <div style={{ width: 500, height: 500 }}>
      <ProjectTimeline
        timeline={{ projectId: ProjectId.make("timeline-test"), events, hasOlder: false }}
      />
    </div>,
    // The timeline has no navigation or router dependencies.
    { router: false },
  );
  const attention = screen.getByRole("button", { name: /Check recovery\. Awaiting input/ });
  const first = screen.getByRole("button", { name: /Check recovery\. Thread started/ });
  const upcoming = screen.getByRole("button", { name: /Mac smoke checks\. Run a prompt/ });
  await userEvent.click(screen.getByRole("button", { name: "Current activity" }));
  await expect.element(attention).toHaveFocus();
  await expect.element(attention).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{End}");
  await expect.element(upcoming).toHaveFocus();
  await expect.element(upcoming).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Home}");
  await expect.element(first).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(attention).toHaveFocus();
  await expect.element(attention).toHaveAttribute("aria-pressed", "true");
});

it("keeps continuous project and work spines centered through dates, compact layout, and zoom", async () => {
  const events = [
    event({
      id: "target-before",
      entityKind: "target",
      entityId: "target",
      family: "target",
      title: "Project direction",
      at: "2026-11-04T09:00:00.000Z",
    }),
    event({ id: "work-before", title: "Earlier work", at: "2026-11-04T10:00:00.000Z" }),
    event({
      id: "review-before",
      entityKind: "review",
      entityId: "review",
      family: "model",
      title: "Project review",
      at: "2026-11-05T09:00:00.000Z",
      projectScope: true,
    }),
    event({
      id: "journal-between",
      entityKind: "journal",
      entityId: "unrelated-journal",
      family: "model",
      title: "An unrelated saved journal with a long readable caption",
      at: "2026-11-05T09:30:00.000Z",
    }),
    event({
      id: "proposal-between",
      entityKind: "suggestion",
      entityId: "proposal",
      family: "suggestion",
      title: "Proposed follow-up",
      at: "2026-11-05T10:00:00.000Z",
      parentIds: ["review-before"],
      relatedEventIds: ["target-before", "work-before"],
    }),
    event({
      id: "schedule-after",
      entityKind: "prompt-schedule",
      entityId: "schedule",
      family: "schedule",
      title: "Project schedule",
      at: "2026-11-06T09:00:00.000Z",
    }),
    event({ id: "work-after", title: "Later work", at: "2026-11-06T10:00:00.000Z" }),
  ];
  const timeline = { projectId: ProjectId.make("timeline-spines"), events, hasOlder: false };
  await using screen = await render(
    <div style={{ width: 720, height: 580 }}>
      <ProjectTimeline timeline={timeline} />
    </div>,
    // Geometry and controls are local to the timeline; no route is involved.
    { router: false },
  );
  const assertSpines = async () => {
    await vi.waitFor(() => {
      const canvas = screen.container.querySelector<HTMLElement>("[data-timeline-canvas]");
      expect(canvas).not.toBeNull();
      const bounds = canvas!.getBoundingClientRect();
      expect(screen.container.querySelectorAll("[data-timeline-spine]")).toHaveLength(2);
      for (const [lane, ids] of [
        ["project", ["target-before"]],
        ["work", ["work-before", "work-after"]],
      ] as const) {
        const spine = screen.container.querySelector<HTMLElement>(
          `[data-timeline-spine="${lane}"]`,
        );
        expect(spine).not.toBeNull();
        const rail = spine!.getBoundingClientRect();
        expect(rail.height).toBeGreaterThan(0);
        expect(rail.top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(rail.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        const centers = ids.map((id) => {
          const marker = screen.container.querySelector<HTMLElement>(
            `[data-timeline-marker="${id}"]`,
          );
          expect(marker).not.toBeNull();
          const box = marker!.getBoundingClientRect();
          expect(
            Math.abs(rail.left + rail.width / 2 - box.left - box.width / 2),
            `${lane} spine center ${rail.left + rail.width / 2} must match ${id} marker center ${box.left + box.width / 2}`,
          ).toBeLessThan(1);
          return box.top + box.height / 2;
        });
        expect(rail.top).toBeLessThanOrEqual(Math.min(...centers));
        expect(rail.bottom).toBeGreaterThanOrEqual(Math.max(...centers));
        expect(rail.height).toBeGreaterThanOrEqual(Math.max(...centers) - Math.min(...centers));
      }
      const actionCenters = [
        "review-before",
        "journal-between",
        "proposal-between",
        "schedule-after",
      ].map((id) => {
        const marker = screen.container.querySelector<HTMLElement>(
          `[data-timeline-marker="${id}"]`,
        )!;
        const box = marker.getBoundingClientRect();
        return box.left + box.width / 2;
      });
      expect(Math.max(...actionCenters) - Math.min(...actionCenters)).toBeLessThan(1);
      const scope = screen.container.querySelector<SVGPathElement>(
        '[data-connection="scope"][data-destination-event="review-before"]',
      )!;
      const start = scope.getPointAtLength(0);
      const end = scope.getPointAtLength(scope.getTotalLength());
      const rail = screen.container
        .querySelector('[data-timeline-spine="project"]')!
        .getBoundingClientRect();
      expect(Math.abs(bounds.left + start.x - rail.left - rail.width / 2)).toBeLessThan(1);
      expect(Math.abs(bounds.left + end.x - actionCenters[0]!)).toBeLessThan(1);
      expect(start.y).toBeCloseTo(end.y, 1);
      expect(screen.container.querySelector('[data-connection="source"]')).not.toBeNull();
    });
  };
  await assertSpines();
  const proposal = screen.getByRole("button", { name: /Proposed follow-up/ });
  await expect.element(proposal).toHaveAccessibleDescription(/Project direction/);
  await expect.element(proposal).toHaveAccessibleDescription(/Earlier work/);
  expect(screen.container.querySelector('[data-connection="focus"]')).toBeNull();
  await userEvent.click(proposal);
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-connection="focus"]')).not.toBeNull(),
  );
  const laterWork = screen.getByRole("button", { name: /Later work\. Thread started/ });
  await userEvent.click(laterWork);
  expect(screen.container.querySelector('[data-connection="focus"]')).toBeNull();
  await screen.rerender(
    <div style={{ width: 360, height: 580 }}>
      <ProjectTimeline timeline={timeline} />
    </div>,
  );
  await assertSpines();
  await userEvent.click(screen.getByRole("button", { name: "Make timeline larger" }));
  await expect
    .element(screen.getByRole("button", { name: "Reset timeline size" }))
    .toHaveTextContent("110%");
  await assertSpines();
  await expect.element(laterWork).toHaveAttribute("aria-pressed", "true");
});

it("opens events on click and Enter while arrow navigation only selects", async () => {
  const onOpenEvent = vi.fn();
  const events = [
    event({ detail: "Restore the last saved draft." }),
    event({ id: "next", title: "Next work", detail: "Run the keyboard check." }),
  ];
  await using screen = await render(
    <div style={{ width: 500, height: 500 }}>
      <ProjectTimeline
        timeline={{ projectId: ProjectId.make("timeline-open"), events, hasOlder: false }}
        onOpenEvent={onOpenEvent}
        detailPresentation={() => "external"}
      />
    </div>,
    // Opening an event is delegated to the parent; the renderer has no route dependency.
    { router: false },
  );
  const first = screen.getByRole("button", { name: /Check recovery\. Thread started/ });
  const next = screen.getByRole("button", { name: /Next work\. Thread started/ });
  const preview = page.getByRole("tooltip");
  await userEvent.hover(first);
  await expect.element(preview).toHaveTextContent("Restore the last saved draft.");
  await expect.element(first).toHaveAccessibleDescription("Restore the last saved draft.");
  await userEvent.hover(next);
  await expect.element(preview).toHaveTextContent("Run the keyboard check.");
  await userEvent.keyboard("{Escape}");
  await expect.element(preview).not.toBeInTheDocument();
  expect(onOpenEvent).not.toHaveBeenCalled();
  await userEvent.click(first);
  expect(onOpenEvent).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{ArrowDown}");
  expect(onOpenEvent).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: /Next work\. Thread started/ }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Enter}");
  expect(onOpenEvent).toHaveBeenCalledTimes(2);
  expect(onOpenEvent.mock.lastCall?.[0].id).toBe("next");
  await expect
    .element(screen.getByRole("button", { name: "Clear timeline selection" }))
    .not.toBeInTheDocument();
});
