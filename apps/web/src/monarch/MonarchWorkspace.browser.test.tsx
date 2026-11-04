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

vi.mock("./ProjectBoard", () => ({ ProjectBoard: () => <div>Project threads</div> }));

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
});
