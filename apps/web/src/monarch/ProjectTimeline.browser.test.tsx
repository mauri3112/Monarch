import { ProjectId, type MonarchTimelineEvent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectTimeline } from "./ProjectTimeline";

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
