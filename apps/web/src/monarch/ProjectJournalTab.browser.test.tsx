import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { ProjectJournalTab } from "./ProjectJournalTab";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  query: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../state/monarch", () => ({
  monarchEnvironment: { timeline: { journal: mocks.select } },
}));
vi.mock("../state/query", () => ({ useEnvironmentQuery: mocks.query }));

function setup() {
  mocks.select.mockReset();
  mocks.query.mockReset();
  mocks.refresh.mockReset();
  const projectRef = {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("research"),
  };
  const source = {
    projectId: projectRef.projectId,
    runId: "run-a",
    threadId: "thread-a",
    threadTitle: "Flight recorder",
    reviewRunId: "review-a",
    revision: 2,
    branch: "recovery",
    worktreePath: "/synthetic/recovery",
    completedAt: "2026-11-05T17:00:00.000Z",
    startedAt: "2026-11-05T17:01:00.000Z",
    recordedAt: "2026-11-05T17:02:00.000Z",
    modelSelection: {
      instanceId: "codex",
      model: "saved-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    entries: [
      {
        kind: "decision",
        title: "Retain the recovery log",
        body: "Keep the recorded output with the source run.",
        scope: "project",
        branch: null,
        sourceRefs: [],
        contradictsEntryIds: [],
      },
    ],
  };
  const onOpenThread = vi.fn();
  const reader = () => (
    <ProjectJournalTab
      projectRef={projectRef}
      runId={source.runId}
      revision={source.revision}
      onOpenThread={onOpenThread}
    />
  );
  return { reader, source, onOpenThread, projectRef };
}

it("reads the saved revision and only opens its source on request", async () => {
  const { reader, source, projectRef, onOpenThread } = setup();
  mocks.query.mockReturnValue({ data: { journal: source }, error: null });
  await using screen = await render(reader());
  expect(mocks.select).toHaveBeenCalledWith({
    environmentId: projectRef.environmentId,
    input: { projectId: projectRef.projectId, runId: source.runId, revision: 2 },
  });
  await expect.element(screen.getByRole("heading", { name: source.threadTitle })).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: source.entries[0]!.title }))
    .toBeVisible();
  await expect.element(screen.getByText(source.entries[0]!.body)).toBeVisible();
  await expect.element(screen.getByText("Journal · Revision 2")).toBeVisible();
  await expect.element(screen.getByText("saved-model")).toBeVisible();
  await expect.element(screen.getByText("high", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("recovery", { exact: true })).toBeVisible();
  expect(onOpenThread).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open source thread" }));
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(source.threadId);
  mocks.query.mockReturnValue({ data: { journal: null }, error: null });
  await screen.rerender(reader());
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Journal revision 2 is unavailable in this project.");
  await expect.element(screen.getByText(source.entries[0]!.body)).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Open source thread" }))
    .not.toBeInTheDocument();
});

it("distinguishes loading, empty receipts and retryable read failures", async () => {
  const { reader, source, onOpenThread } = setup();
  mocks.query.mockReturnValue({ data: null, error: null });
  await using screen = await render(reader());
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading journal…");
  mocks.query.mockReturnValue({ data: { journal: { ...source, entries: [] } }, error: null });
  await screen.rerender(reader());
  await expect
    .element(screen.getByText("This revision recorded no journal entries for the turn."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open source thread" })).toBeVisible();
  mocks.query.mockReturnValue({ data: null, error: "Connection lost.", refresh: mocks.refresh });
  await screen.rerender(reader());
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not load the journal. Connection lost.");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(onOpenThread).not.toHaveBeenCalled();
});
