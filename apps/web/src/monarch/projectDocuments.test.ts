import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { DraftId } from "../composerDraftStore";
import {
  openProjectDocumentTab,
  projectDocumentKey,
  projectDocumentSelection,
} from "./projectDocuments";

it("deduplicates scoped documents and keeps draft promotion in its original suggestion tab", () => {
  const project = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));
  const draftId = "draft" as DraftId;
  const draft = { kind: "draft", draftId, title: "Proposal", suggestionId: "suggestion" } as const;
  const first = openProjectDocumentTab([], project, draft);
  const ref = scopeThreadRef(project.environmentId, ThreadId.make("thread"));
  const promoted = openProjectDocumentTab(
    first.tabs,
    project,
    { kind: "thread", threadRef: ref },
    draftId,
  );
  expect(promoted.tabs).toHaveLength(1);
  expect(promoted.tab.id).toBe(first.tab.id);
  expect(promoted.tab.document).toMatchObject({
    kind: "thread",
    suggestionId: "suggestion",
    title: "Proposal",
  });
  const reopened = openProjectDocumentTab(promoted.tabs, project, {
    kind: "thread",
    threadRef: ref,
  });
  expect(reopened.tabs).toHaveLength(1);
  const recordedTurn = {
    entityKind: "thread",
    entityId: ref.threadId,
    eventId: "turn:recorded-run",
  } as const;
  expect(projectDocumentSelection(reopened.tab.document, recordedTurn)).toEqual(recordedTurn);
  expect(
    projectDocumentSelection(reopened.tab.document, { ...recordedTurn, entityId: "unrelated" }),
  ).toEqual({ entityKind: "thread", entityId: ref.threadId });
  const proposal = openProjectDocumentTab(reopened.tabs, project, {
    kind: "suggestion",
    suggestionId: "suggestion",
    title: "Proposal",
  });
  expect(proposal.tabs).toHaveLength(1);
  expect(proposal.tab.id).toBe(first.tab.id);
  const journal = { kind: "journal", runId: "run", revision: 1, title: "Journal" } as const;
  expect(projectDocumentKey(project, journal)).not.toBe(
    projectDocumentKey(project, { ...journal, revision: 2 }),
  );
  expect(projectDocumentKey(project, journal)).not.toBe(
    projectDocumentKey(
      scopeProjectRef(EnvironmentId.make("elsewhere"), project.projectId),
      journal,
    ),
  );
  expect(projectDocumentKey(project, journal)).not.toBe(
    projectDocumentKey(
      scopeProjectRef(project.environmentId, ProjectId.make("different-project")),
      journal,
    ),
  );
});
