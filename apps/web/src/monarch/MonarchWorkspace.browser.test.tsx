import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import type { ThreadRouteTarget } from "../threadRoutes";
import "../index.css";
import type { DraftId } from "../composerDraftStore";
import { MonarchWorkspace } from "./MonarchWorkspace";

const mocks = vi.hoisted(() => ({
  coldProjectId: null as string | null,
  resolveSuggestion: vi.fn<(...args: unknown[]) => Promise<ThreadRouteTarget | null>>(
    async () => null,
  ),
}));

vi.mock("./useOpenSuggestionDraft", () => ({
  useOpenSuggestionDraft: () => ({ resolveSuggestion: mocks.resolveSuggestion }),
}));
vi.mock("./ProjectJournalTab", () => ({
  ProjectJournalTab: ({ revision }: { revision: number }) => <div>Journal revision {revision}</div>,
}));
vi.mock("../components/ThreadRouteView", () => ({
  ThreadRouteView: ({ target }: { target: ThreadRouteTarget }) => (
    <textarea
      aria-label="Conversation composer"
      data-native-target={target.kind === "draft" ? target.draftId : target.threadRef.threadId}
      defaultValue=""
    />
  ),
}));

vi.mock("./ProjectBoard", async () => {
  const { createPortal } = await import("react-dom");
  const { useMonarchDock } = await import("./MonarchDockContext");
  return {
    ProjectBoard: () => {
      const dock = useMonarchDock();
      return (
        <div>
          Project threads
          <output aria-label="Current graph owner">
            {JSON.stringify(dock?.selection ?? null)}
          </output>
          {dock?.documentHost && dock.activeDocument?.kind === "suggestion"
            ? createPortal(<div>Read-only proposal preview</div>, dock.documentHost)
            : null}
          <button onClick={() => dock?.open("context")}>Open project context</button>
          <button onClick={() => dock?.open("included", "main")}>Open included context</button>
          {dock?.documentHost &&
          dock.activeDocument?.kind === "draft" &&
          dock.activeDocument.suggestionId
            ? createPortal(
                <div>Proposal origin: {dock.activeDocument.suggestionId}</div>,
                dock.documentHost,
              )
            : null}
          {dock?.activeKind === "context" && dock.host
            ? createPortal(
                <div>
                  <textarea aria-label="Project notes" defaultValue="" />
                  <button onClick={dock.close}>Close project context</button>
                </div>,
                dock.host,
              )
            : null}
        </div>
      );
    },
  };
});

vi.mock("./ProjectActivityDock", async () => {
  const { useMonarchDock } = await import("./MonarchDockContext");
  return {
    ProjectActivityDock: ({ onToggleExpanded }: { onToggleExpanded: () => void }) => {
      const dock = useMonarchDock();
      return (
        <div>
          <textarea aria-label="Timeline viewport" defaultValue="" />
          <button onClick={onToggleExpanded}>Expand graph</button>
          <button
            onClick={() =>
              dock?.openDocument?.({
                kind: "thread",
                threadRef: scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("cold")),
                title: "Cold source",
              })
            }
          >
            Open cold source
          </button>
          <button onClick={() => dock?.open("context")}>Show project context</button>
          <button onClick={() => dock?.open("included", "main")}>Show included context</button>
          <button
            onClick={() => {
              dock?.selectEntity?.({
                entityKind: "suggestion",
                entityId: "proposal",
                eventId: "proposal:event:2",
              });
              dock?.openDocument?.({
                kind: "suggestion",
                suggestionId: "proposal",
                title: "Proposal",
              });
            }}
          >
            Open proposal
          </button>
          <button
            onClick={() =>
              dock?.openDocument?.({ kind: "journal", runId: "run", revision: 1, title: "Journal" })
            }
          >
            Open journal
          </button>
          <button
            onClick={() =>
              dock?.openDocument?.({
                kind: "journal",
                runId: "run",
                revision: 2,
                title: "Journal 2",
              })
            }
          >
            Open journal 2
          </button>
        </div>
      );
    },
  };
});

vi.mock("./ProjectContextIncludedNotice", () => ({
  ProjectContextIncludedNotice: ({ panelOnly }: { panelOnly?: boolean }) =>
    panelOnly ? <div>Included context panel</div> : null,
}));

vi.mock("../state/entities", () => ({
  useProject: (ref: { projectId: string; environmentId: string } | null) =>
    ref ? { id: ref.projectId, environmentId: ref.environmentId, title: "Example project" } : null,
  useQuietThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === "cold" ? null : { projectId: "project" },
  useQuietThreadProjection: (ref: { threadId: string } | null) =>
    ref?.threadId === "cold" && mocks.coldProjectId
      ? { projection: { thread: { projectId: mocks.coldProjectId } } }
      : null,
}));

vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "live" }));

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftSession: () => ({
        projectId: "project",
        environmentId: "environment",
        threadId: "thread",
      }),
      getDraftSessionByRef: () => null,
      getPromotedDraftRedirect: () => ({ environmentId: "environment", threadId: "thread" }),
      getDraftIdByRef: () => null,
    }),
}));

const roomyContainer = () => {
  const container = document.createElement("div");
  container.style.width = "1100px";
  return container;
};

it("keeps the conversation mounted through pane expansion, draft promotion, and a background modal", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const draftTarget = { kind: "draft", draftId: "draft" as DraftId } as const;
  const threadTarget = {
    kind: "server",
    threadRef: scopeThreadRef(projectRef.environmentId, ThreadId.make("thread")),
  } as const;
  await using screen = await render(
    <MonarchWorkspace target={draftTarget} projectRef={projectRef} />,
    { container: roomyContainer() },
  );
  const composer = screen.getByRole("textbox", { name: "Conversation composer" });
  await userEvent.fill(composer, "Keep this unsent text");
  await userEvent.click(screen.getByRole("button", { name: "Expand thread" }));
  await expect.element(composer).toHaveValue("Keep this unsent text");
  await screen.rerender(<MonarchWorkspace target={threadTarget} projectRef={null} />);
  await expect.element(composer).toHaveValue("Keep this unsent text");
  await screen.rerender(<MonarchWorkspace target={threadTarget} projectRef={null} background />);
  await screen.rerender(<MonarchWorkspace target={threadTarget} projectRef={null} />);
  await expect.element(composer).toHaveValue("Keep this unsent text");
  await userEvent.click(screen.getByRole("button", { name: "Show project beside thread" }));
  await expect.element(composer).toHaveValue("Keep this unsent text");
  await expect.element(screen.getByRole("button", { name: "Hide document pane" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show project context" }));
  const notes = screen.getByRole("textbox", { name: "Project notes" });
  await userEvent.fill(notes, "Keep this context edit");
  await screen.rerender(<MonarchWorkspace target={null} projectRef={projectRef} />);
  await expect.element(notes).toHaveValue("Keep this context edit");
  await screen.rerender(<MonarchWorkspace target={threadTarget} projectRef={projectRef} />);
  await expect.element(notes).toHaveValue("Keep this context edit");
  await userEvent.click(screen.getByRole("button", { name: "Close project context" }));
  await userEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Show included context" }));
  await expect.element(screen.getByText("Included context panel")).toBeVisible();
  await screen.rerender(<MonarchWorkspace target={null} projectRef={projectRef} />);
  await expect.element(screen.getByText("Included context panel")).not.toBeInTheDocument();
});

it("keeps graph and native editor mounted while deduplicating documents and ignoring a closed suggestion completion", async () => {
  let complete: (target: ThreadRouteTarget | null) => void = () => {};
  mocks.resolveSuggestion.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const target = { kind: "draft", draftId: "draft" as DraftId } as const;
  await using screen = await render(<MonarchWorkspace target={target} projectRef={projectRef} />, {
    router: "/draft/draft",
    container: roomyContainer(),
  });
  const composer = screen.getByRole("textbox", { name: "Conversation composer" });
  const graph = screen.getByRole("textbox", { name: "Timeline viewport" });
  await userEvent.fill(composer, "Unsent native draft");
  await userEvent.fill(graph, "Keep graph viewport");
  await userEvent.click(screen.getByRole("button", { name: "Open proposal" }));
  await userEvent.click(screen.getByRole("button", { name: "Open proposal" }));
  expect(mocks.resolveSuggestion).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("tab", { name: "Proposal", exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
  await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
  await expect.element(screen.getByText("Journal revision 1")).toBeVisible();
  await expect.element(graph).toHaveValue("Keep graph viewport");
  await userEvent.click(screen.getByRole("button", { name: "Close Proposal", exact: true }));
  await act(async () => complete({ kind: "draft", draftId: "late-draft" as DraftId }));
  await expect
    .element(screen.getByRole("tab", { name: "Proposal", exact: true }))
    .not.toBeInTheDocument();
  expect(screen.router?.state.location.pathname).toBe("/draft/draft");
  await userEvent.click(screen.getByRole("tab", { name: "Draft thread", exact: true }));
  await expect.element(composer).toHaveValue("Unsent native draft");
  expect(screen.container.querySelectorAll('[aria-label="Conversation composer"]')).toHaveLength(1);
});

it("converts an inactive suggestion in place without stealing the active journal or navigating", async () => {
  let complete: (target: ThreadRouteTarget | null) => void = () => {};
  mocks.resolveSuggestion.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  await using screen = await render(<MonarchWorkspace target={null} projectRef={projectRef} />, {
    router: "/workspace/environment/project",
    container: roomyContainer(),
  });
  await userEvent.click(screen.getByRole("button", { name: "Open proposal" }));
  await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
  await act(async () => complete({ kind: "draft", draftId: "prepared" as DraftId }));
  await expect
    .element(screen.getByRole("tab", { name: "Journal", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  expect(screen.router?.state.location.pathname).toBe("/workspace/environment/project");
  await userEvent.click(screen.getByRole("tab", { name: "Proposal", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation composer" }))
    .toHaveAttribute("data-native-target", "prepared");
  expect(screen.router?.state.location.pathname).toBe("/draft/prepared");
});

it("returns to the same mounted Timeline and native draft on a narrow workspace", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  const container = document.createElement("div");
  container.style.width = "620px";
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const target = { kind: "draft", draftId: "draft" as DraftId } as const;
  await using screen = await render(<MonarchWorkspace target={target} projectRef={projectRef} />, {
    container,
    router: "/draft/draft",
  });
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Conversation composer" }),
    "Narrow unsent draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  const graph = screen.container.querySelector('[aria-label="Timeline viewport"]');
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Timeline viewport" }),
    "Keep this graph position",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
  await expect.element(screen.getByText("Journal revision 1")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  expect(screen.container.querySelector('[aria-label="Timeline viewport"]')).toBe(graph);
  await expect.element(screen.getByText("Journal revision 1")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: "Timeline viewport" }))
    .toHaveValue("Keep this graph position");
  await userEvent.click(screen.getByRole("button", { name: "Documents 2" }));
  await userEvent.click(screen.getByRole("tab", { name: "Draft thread", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation composer" }))
    .toHaveValue("Narrow unsent draft");
  expect(screen.container.querySelectorAll('[aria-label="Conversation composer"]')).toHaveLength(1);
  const toggle = screen
    .getByRole("navigation", { name: "Project navigation" })
    .getByRole("button", { name: "Timeline", exact: true });
  await userEvent.click(screen.getByRole("button", { name: "Hide document pane" }));
  await expect.element(screen.getByRole("textbox", { name: "Timeline viewport" })).toBeVisible();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByRole("region", { name: "Project workspace", exact: true }))
    .toBeVisible();
  expect(screen.container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(
    (screen.container.querySelector('[aria-label="Conversation composer"]') as HTMLTextAreaElement)
      .value,
  ).toBe("Narrow unsent draft");
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole("button", { name: "Documents 2" }));
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation composer" }))
    .toHaveValue("Narrow unsent draft");
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("textbox", { name: "Timeline viewport" })).toBeVisible();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByRole("textbox", { name: "Conversation composer" }))
    .toHaveValue("Narrow unsent draft");
});

it("retains the established project while its explicitly opened cold thread loads and validates its eventual owner", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  mocks.coldProjectId = null;
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const coldTarget = {
    kind: "server",
    threadRef: scopeThreadRef(projectRef.environmentId, ThreadId.make("cold")),
  } as const;
  try {
    await using screen = await render(
      <MonarchWorkspace
        target={{ kind: "draft", draftId: "draft" as DraftId }}
        projectRef={projectRef}
      />,
      {
        container: roomyContainer(),
        router: "/draft/draft",
      },
    );
    await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Open cold source" }));
    await screen.rerender(<MonarchWorkspace target={coldTarget} projectRef={null} />);
    await expect.element(screen.getByRole("tab", { name: "Journal", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("tab", { name: "Cold source", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    mocks.coldProjectId = "project";
    await screen.rerender(<MonarchWorkspace target={coldTarget} projectRef={null} />);
    await expect.element(screen.getByRole("tab", { name: "Journal", exact: true })).toBeVisible();
    mocks.coldProjectId = "other-project";
    await screen.rerender(<MonarchWorkspace target={coldTarget} projectRef={null} />);
    await expect
      .element(screen.getByRole("tab", { name: "Journal", exact: true }))
      .not.toBeInTheDocument();
  } finally {
    mocks.coldProjectId = null;
  }
});

it("restores a direct suggestion draft's context without reserving or preparing again", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  const draftId = "monarch-suggestion-environment-proposal" as DraftId;
  await using screen = await render(
    <MonarchWorkspace target={{ kind: "draft", draftId }} projectRef={null} />,
    { container: roomyContainer(), router: `/draft/${draftId}` },
  );
  await expect.element(screen.getByText("Proposal origin: proposal")).toBeVisible();
  await expect
    .element(screen.getByRole("tab", { name: "Suggested thread", exact: true }))
    .toBeVisible();
  expect(mocks.resolveSuggestion).not.toHaveBeenCalled();
});

it("roves document tabs, restores exact graph owners, and returns focus on close without preparing again", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  const container = roomyContainer();
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  await using screen = await render(
    <MonarchWorkspace
      target={{ kind: "draft", draftId: "draft" as DraftId }}
      projectRef={projectRef}
    />,
    { container, router: "/draft/draft" },
  );
  const composer = screen.getByRole("textbox", { name: "Conversation composer" });
  const nativeNode = screen.container.querySelector('[aria-label="Conversation composer"]');
  await userEvent.fill(composer, "Keep native text through tab navigation");
  await userEvent.click(screen.getByRole("button", { name: "Open proposal", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Open journal 2", exact: true }));
  const draftTab = screen.getByRole("tab", { name: "Draft thread", exact: true });
  const proposalTab = screen.getByRole("tab", { name: "Proposal", exact: true });
  const journalTab = screen.getByRole("tab", { name: "Journal 2", exact: true });
  await userEvent.click(journalTab);
  const tab = screen.container.querySelector('[role="tab"][aria-selected="true"]')!;
  const panel = screen.container.querySelector('[role="tabpanel"]')!;
  expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  expect(screen.container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  await expect.element(screen.getByRole("button", { name: "Expand document pane" })).toBeVisible();
  container.style.width = "620px";
  await userEvent.keyboard("{Home}");
  await expect.element(draftTab).toHaveFocus();
  await expect.element(composer).toHaveValue("Keep native text through tab navigation");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(proposalTab).toHaveFocus();
  await expect.element(screen.getByText("Read-only proposal preview")).toBeVisible();
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[aria-label="Current graph owner"]')?.textContent,
    ).toContain('"eventId":"proposal:event:2"'),
  );
  await userEvent.keyboard("{End}");
  await expect.element(journalTab).toHaveFocus();
  await expect.element(screen.getByText("Journal revision 2")).toBeVisible();
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[aria-label="Current graph owner"]')?.textContent,
    ).toContain('"eventId":"journal:run:2"'),
  );
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(draftTab).toHaveFocus();
  await expect.element(composer).toHaveValue("Keep native text through tab navigation");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(journalTab).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Close Journal 2", exact: true }));
  await expect.element(proposalTab).toHaveFocus();
  await expect.element(screen.getByText("Read-only proposal preview")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Close Proposal", exact: true }));
  await expect.element(draftTab).toHaveFocus();
  expect(screen.container.querySelector('[aria-label="Conversation composer"]')).toBe(nativeNode);
  expect(mocks.resolveSuggestion).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Close Draft thread", exact: true }));
  await expect.element(screen.getByRole("region", { name: "Project control panel" })).toHaveFocus();
});

it("keeps a state-aware Timeline toggle after Projects through graph and document layouts", async () => {
  mocks.resolveSuggestion.mockReset().mockResolvedValue(null);
  const container = roomyContainer();
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  await using screen = await render(
    <MonarchWorkspace
      target={{ kind: "draft", draftId: "draft" as DraftId }}
      projectRef={projectRef}
    />,
    { container, router: "/draft/draft" },
  );
  const navigation = screen.getByRole("navigation", { name: "Project navigation" });
  await expect.element(navigation).toBeVisible();
  const toggle = navigation.getByRole("button", { name: "Timeline", exact: true });
  const composer = screen.getByRole("textbox", { name: "Conversation composer" });
  await userEvent.fill(composer, "Preserve this unsent draft");
  const nativeNode = screen.container.querySelector('[aria-label="Conversation composer"]');
  const projectLink = screen.container.querySelector('nav[aria-label="Project navigation"] a')!;
  expect(projectLink.nextElementSibling?.textContent?.trim()).toBe("Timeline");
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.element(composer).toHaveValue("Preserve this unsent draft");
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("textbox", { name: "Timeline viewport" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Expand thread", exact: true }));
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.element(composer).toHaveValue("Preserve this unsent draft");
  await userEvent.click(screen.getByRole("button", { name: "Open journal", exact: true }));
  container.style.width = "620px";
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("textbox", { name: "Timeline viewport" })).toBeVisible();
  await userEvent.click(toggle);
  await expect.element(screen.getByText("Journal revision 1")).toBeVisible();
  await expect
    .element(screen.getByRole("tab", { name: "Draft thread", exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Draft thread", exact: true }));
  await expect.element(composer).toHaveValue("Preserve this unsent draft");
  expect(screen.container.querySelector('[aria-label="Conversation composer"]')).toBe(nativeNode);
  container.style.width = "1100px";
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "Hide document pane" }));
  await userEvent.click(screen.getByRole("button", { name: "Expand graph" }));
  await expect.element(navigation).toBeVisible();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByRole("region", { name: "Project workspace", exact: true }))
    .toBeVisible();
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("textbox", { name: "Timeline viewport" })).toBeVisible();
});
