import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectPlanning } from "./ProjectPlanning";

const mocks = vi.hoisted(() => ({
  canEdit: true,
  context: { revision: 2, settings: { enabled: false, paused: false } },
  data: {
    targets: [
      {
        id: "target-1",
        projectId: "project-1",
        title: "Improve reliability",
        description: "",
        indicators: [],
        constraints: [],
        status: "active",
        revision: 2,
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ],
    suggestions: [
      {
        id: "suggestion-1",
        projectId: "project-1",
        title: "Check recovery",
        prompt: "Test restore after restart",
        rationale: "Several threads changed persistence",
        targets: [{ targetId: "target-1", revision: 1 }],
        sourceThreadIds: [],
        status: "suggested",
        revision: 3,
        usedThreadId: null,
        draftThreadId: null,
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ],
  },
  command: vi.fn(async (_command: unknown, _input: unknown) => ({ _tag: "Success", value: {} })),
  prepare: vi.fn(async () => {}),
  refresh: vi.fn(),
  threadShells: [] as Array<{ id: string; environmentId: string; projectId: string }>,
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.canEdit,
}));
vi.mock("../state/monarch", () => ({
  monarchEnvironment: {
    projectState: () => ({ kind: "planning" }),
    context: { live: () => ({ kind: "context" }) },
    createTarget: { permissionAtom: () => ({}) },
    updateTarget: { permissionAtom: () => ({}) },
    updateSuggestion: { permissionAtom: () => ({}) },
    setSuggestionStatus: { permissionAtom: () => ({}) },
    markSuggestionUsed: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string }) => ({
    data: query.kind === "context" ? mocks.context : mocks.data,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../state/entities", () => ({ useQuietThreadShells: () => mocks.threadShells }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { permissionAtom: unknown }) => (input: unknown) =>
    mocks.command(command, input),
}));
vi.mock("./usePrepareSuggestionDraft", () => ({
  usePrepareSuggestionDraft: () => ({ prepare: mocks.prepare, preparingId: null, error: null }),
}));
vi.mock("./ProjectReviewSchedules", () => ({ ProjectReviewSchedules: () => null }));
vi.mock("./ProjectSchedules", () => ({ ProjectSchedules: () => null }));
vi.mock("./SuggestionSettingsPanel", () => ({ SuggestionSettingsPanel: () => null }));

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);

it("saves a Target in the current environment and project", async () => {
  mocks.canEdit = true;
  mocks.command.mockClear();
  await using screen = await render(
    <ProjectPlanning projectRef={projectRef} projectTitle="Test project" archived={false} />,
    {
      router: "/workspace/environment-1/project-1",
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Add target" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "Title" }), "Make setup dependable");
  await userEvent.click(screen.getByRole("button", { name: "Save Target" }));
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  expect(mocks.command.mock.calls.at(-1)?.[1]).toMatchObject({
    environmentId: "environment-1",
    input: { projectId: "project-1", title: "Make setup dependable", status: "active" },
  });
});

it("requires explicit review before a stale suggestion can prepare a draft", async () => {
  mocks.canEdit = true;
  mocks.command.mockClear();
  mocks.prepare.mockClear();
  await using screen = await render(
    <ProjectPlanning projectRef={projectRef} projectTitle="Test project" archived={false} />,
    {
      router: "/workspace/environment-1/project-1",
    },
  );
  await expect.element(screen.getByRole("button", { name: "Use" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.click(screen.getByRole("checkbox", { name: /I reviewed this prompt/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  expect(mocks.command.mock.calls.at(-1)?.[1]).toMatchObject({
    input: {
      projectId: "project-1",
      id: "suggestion-1",
      expectedRevision: 3,
      targets: [{ targetId: "target-1", revision: 2 }],
    },
  });
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("requires explicit review when project context changes", async () => {
  mocks.canEdit = true;
  mocks.command.mockClear();
  mocks.prepare.mockClear();
  const suggestion = mocks.data.suggestions[0]!;
  suggestion.targets[0]!.revision = 2;
  Object.assign(suggestion, { contextRevision: 1 });
  try {
    await using screen = await render(
      <ProjectPlanning projectRef={projectRef} projectTitle="Test project" archived={false} />,
      { router: "/workspace/environment-1/project-1" },
    );
    await expect.element(screen.getByText("Project context changed")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Use" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /reviewed this prompt against the current project context/,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
    expect(mocks.command.mock.calls.at(-1)?.[1]).toMatchObject({
      environmentId: "environment-1",
      input: { projectId: "project-1", id: "suggestion-1", contextRevision: 2 },
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  } finally {
    suggestion.targets[0]!.revision = 1;
    Reflect.deleteProperty(suggestion, "contextRevision");
  }
});

it("keeps mutations unavailable without an operate grant", async () => {
  mocks.canEdit = false;
  await using screen = await render(
    <ProjectPlanning projectRef={projectRef} projectTitle="Test project" archived={false} />,
    {
      router: "/workspace/environment-1/project-1",
    },
  );
  await expect.element(screen.getByRole("button", { name: "Add target" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Use" })).toBeDisabled();
});

it("records a suggestion as used only after its reserved thread is persisted", async () => {
  mocks.canEdit = true;
  mocks.command.mockClear();
  mocks.data.suggestions[0]!.draftThreadId = "thread-1" as never;
  mocks.threadShells.push({
    id: "thread-1",
    environmentId: "environment-1",
    projectId: "project-1",
  });
  try {
    await using screen = await render(
      <ProjectPlanning projectRef={projectRef} projectTitle="Test project" archived={false} />,
      { router: "/workspace/environment-1/project-1" },
    );
    await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
    expect(mocks.command.mock.calls.at(-1)?.[1]).toMatchObject({
      environmentId: "environment-1",
      input: {
        projectId: "project-1",
        id: "suggestion-1",
        threadId: "thread-1",
        expectedRevision: 3,
      },
    });
    expect(screen.getByRole("button", { name: "Continue draft" })).toBeDefined();
  } finally {
    mocks.data.suggestions[0]!.draftThreadId = null;
    mocks.threadShells.length = 0;
  }
});
