import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectContextPanel } from "./ProjectContextPanel";

const mocks = vi.hoisted(() => ({
  command: vi.fn(async (_name: string, _input: unknown) => ({ _tag: "Success", value: {} })),
  refresh: vi.fn(),
  cachedSource: {
    threadId: "thread-1",
    title: "Completed work",
    runId: "run-1",
    completedAt: "2026-11-04T10:00:00Z",
    excluded: false,
  },
  latestSource: {
    threadId: "thread-1",
    title: "Completed work",
    runId: "run-1",
    completedAt: "2026-11-04T10:00:00Z",
    excluded: false,
  },
  state: {
    projectId: "project-1",
    revision: 0,
    settingsRevision: 2,
    settings: {
      enabled: false,
      autoUpdateContext: false,
      suggestAfterWork: false,
      suggestAfterTargetChange: false,
      paused: false,
      modelSelection: null,
      maxUpdatesPerDay: 6,
      maxOpenSuggestions: 20,
      excludedThreadIds: [],
      instructions: "",
      brief: "Original direction",
    },
    entries: [],
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../state/monarch", () => ({
  monarchEnvironment: {
    context: {
      live: () => ({ kind: "context" }),
      history: () => ({ kind: "history" }),
      updateSettings: { kind: "updateSettings", permissionAtom: () => ({}) },
      upsertEntry: { kind: "upsertEntry", permissionAtom: () => ({}) },
      removeEntry: { kind: "removeEntry", permissionAtom: () => ({}) },
      restoreEntry: { kind: "restoreEntry", permissionAtom: () => ({}) },
    },
    continuity: {
      sources: () => ({ kind: "sources" }),
      refresh: { kind: "refresh", permissionAtom: () => ({}) },
    },
  },
}));
vi.mock("../state/query", async () => {
  const { useState } = await import("react");
  return {
    useEnvironmentQuery: (query: { kind: string } | null) => {
      const kind = query?.kind ?? "none";
      const [cached, setCached] = useState(() => [mocks.cachedSource]);
      const [refresh] = useState(() => () => {
        mocks.refresh(kind);
        if (kind === "sources") setCached([mocks.latestSource]);
      });
      return {
        data: kind === "context" ? mocks.state : kind === "sources" ? { sources: cached } : null,
        error: null,
        isPending: false,
        refresh,
      };
    },
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) => (input: unknown) =>
    mocks.command(command.kind, input),
}));
vi.mock("../state/entities", () => ({ useQuietThreadShells: () => [] }));

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);

it("requires a saved review model before building project context", async () => {
  mocks.command.mockClear();
  await using _screen = await render(
    <ProjectContextPanel
      projectRef={projectRef}
      projectTitle="Test project"
      archived={false}
      open
      onClose={() => {}}
    />,
    { router: "/workspace/environment-1/project-1" },
  );
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByRole("button", { name: "Build context" })).toBeDisabled();
  expect(mocks.command.mock.calls.some(([name]) => name === "refresh")).toBe(false);
});

it("loads the latest completed source when the context panel reopens", async () => {
  const panel = () => (
    <ProjectContextPanel
      projectRef={projectRef}
      projectTitle="Test project"
      archived={false}
      open
      onClose={() => {}}
    />
  );
  mocks.latestSource = { ...mocks.cachedSource };
  await using screen = await render(panel(), {
    router: "/workspace/environment-1/project-1",
  });
  const dialog = page.getByRole("dialog");
  const oldTime = new Date(mocks.cachedSource.completedAt).toLocaleString();
  await expect.element(dialog.getByText(oldTime)).toBeVisible();
  await screen.rerender(null);
  mocks.latestSource = {
    ...mocks.cachedSource,
    completedAt: "2026-11-05T21:09:00Z",
  };
  await screen.rerender(panel());
  const newTime = new Date(mocks.latestSource.completedAt).toLocaleString();
  await expect.element(page.getByRole("dialog").getByText(newTime)).toBeVisible();
});
