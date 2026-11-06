import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { ProjectActivityDock } from "./ProjectActivityDock";

const mocks = vi.hoisted(() => ({
  visibilityKey: "visible-1",
  historyRequests: [] as unknown[],
}));
const at = "2026-11-06T10:00:00.000Z";
const makeEvent = (index: number) => ({
  id: `event-${String(index).padStart(3, "0")}`,
  family: "target",
  entityKind: "target",
  entityId: `target-${index}`,
  action: "created",
  title: `Activity ${index}`,
  detail: "",
  at,
  state: "recorded",
  parentIds: [],
  threadId: null,
  runId: null,
});

vi.mock("../state/entities", () => ({ useQuietThreadShells: () => [] }));
vi.mock("../state/monarch", () => ({
  monarchEnvironment: {
    timeline: {
      live: () => ({ kind: "live" }),
      history: (request: unknown) => {
        mocks.historyRequests.push(request);
        return { kind: "history" };
      },
    },
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string } | null) => ({
    data:
      query?.kind === "live"
        ? {
            projectId: "project",
            events: Array.from({ length: 40 }, (_, index) => makeEvent(index + 2)),
            hasOlder: true,
            nextCursor: { at, id: "event-002" },
            visibilityKey: mocks.visibilityKey,
          }
        : query?.kind === "history"
          ? {
              projectId: "project",
              events: [makeEvent(1)],
              nextCursor: null,
              visibilityKey: "visible-1",
            }
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./ProjectTimeline", () => ({
  ProjectTimeline: ({
    timeline,
  }: {
    timeline: { events: Array<{ id: string; title: string }> };
  }) => (
    <div>
      {timeline.events.map((event) => (
        <span key={event.id}>{event.title}</span>
      ))}
    </div>
  ),
}));

it("adds unseen activity on the first older click, reverses, and discards pages after source visibility changes", async () => {
  mocks.visibilityKey = "visible-1";
  mocks.historyRequests = [];
  const projectRef = {
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
  };
  await using screen = await render(
    <ProjectActivityDock projectRef={projectRef} expanded={false} onToggleExpanded={() => {}} />,
  );
  await expect.element(screen.getByText("Activity 1", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load older" }));
  expect(mocks.historyRequests.at(-1)).toEqual({
    environmentId: "environment",
    input: {
      projectId: "project",
      before: { at, id: "event-002" },
      visibilityKey: "visible-1",
    },
  });
  await expect.element(screen.getByText("Activity 1", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Newer activity" }));
  await expect.element(screen.getByText("Activity 1", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load older" }));
  await expect.element(screen.getByText("Activity 1", { exact: true })).toBeVisible();
  mocks.visibilityKey = "visible-2";
  await screen.rerender(
    <ProjectActivityDock projectRef={projectRef} expanded={false} onToggleExpanded={() => {}} />,
  );
  await expect.element(screen.getByText("Activity 1", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Newer activity" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load older" }));
  expect(mocks.historyRequests.at(-1)).toMatchObject({ input: { visibilityKey: "visible-2" } });
  await expect.element(screen.getByText("Activity 1", { exact: true })).not.toBeInTheDocument();
});
