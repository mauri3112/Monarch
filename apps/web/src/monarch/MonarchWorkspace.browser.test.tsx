import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { DraftId } from "../composerDraftStore";
import { MonarchWorkspace } from "./MonarchWorkspace";

vi.mock("../components/ThreadRouteView", () => ({
  ThreadRouteView: () => <textarea aria-label="Conversation composer" defaultValue="" />,
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
          <button onClick={() => dock?.open("context")}>Open project context</button>
          <button onClick={() => dock?.open("included", "main")}>Open included context</button>
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

vi.mock("./ProjectActivityDock", () => ({
  ProjectActivityDock: () => <div>Project Timeline</div>,
}));

vi.mock("./ProjectContextIncludedNotice", () => ({
  ProjectContextIncludedNotice: ({ panelOnly }: { panelOnly?: boolean }) =>
    panelOnly ? <div>Included context panel</div> : null,
}));

vi.mock("../state/entities", () => ({
  useProject: () => ({ id: "project", environmentId: "environment", title: "Example project" }),
  useQuietThreadShell: () => ({ projectId: "project" }),
  useQuietThreadProjection: () => null,
}));

vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "live" }));

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: () => ({ projectId: "project", environmentId: "environment" }),
}));

it("keeps the conversation mounted through pane expansion, draft promotion, and a background modal", async () => {
  const projectRef = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const draftTarget = { kind: "draft", draftId: "draft" as DraftId } as const;
  const threadTarget = {
    kind: "server",
    threadRef: scopeThreadRef(projectRef.environmentId, ThreadId.make("thread")),
  } as const;
  await using screen = await render(
    <MonarchWorkspace target={draftTarget} projectRef={projectRef} />,
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
  await expect
    .element(screen.getByRole("link", { name: "Close thread pane" }))
    .toHaveAttribute("href", "/workspace/environment/project");

  await userEvent.click(screen.getByRole("button", { name: "Open project context" }));
  const notes = screen.getByRole("textbox", { name: "Project notes" });
  await userEvent.fill(notes, "Keep this context edit");
  await screen.rerender(<MonarchWorkspace target={null} projectRef={projectRef} />);
  await expect.element(notes).toHaveValue("Keep this context edit");
  await screen.rerender(<MonarchWorkspace target={threadTarget} projectRef={projectRef} />);
  await expect.element(notes).toHaveValue("Keep this context edit");
  await userEvent.click(screen.getByRole("button", { name: "Close project context" }));
  await userEvent.click(screen.getByRole("button", { name: "Open included context" }));
  await expect.element(screen.getByText("Included context panel")).toBeVisible();
  await screen.rerender(<MonarchWorkspace target={null} projectRef={projectRef} />);
  await expect.element(screen.getByText("Included context panel")).not.toBeInTheDocument();
});
