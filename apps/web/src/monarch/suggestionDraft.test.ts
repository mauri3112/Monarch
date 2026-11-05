import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  NextThreadSuggestion,
  ProjectId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  useComposerDraftStore,
  partializeComposerDraftStoreState,
} from "../composerDraftStore";
import { prepareSuggestionDraft } from "./suggestionDraft";

vi.mock("../state/entities", () => ({ readThreadShell: () => null }));

const environmentId = EnvironmentId.make("planning-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("planning-project"));
const otherProjectRef = scopeProjectRef(environmentId, ProjectId.make("unrelated-project"));
const suggestion = Schema.decodeSync(NextThreadSuggestion)({
  id: "suggestion-1",
  projectId: projectRef.projectId,
  title: "Check recovery",
  prompt: "Verify recovery after a restart.",
  rationale: "A recent thread changed persistence.",
  targets: [],
  sourceThreadIds: [],
  status: "suggested",
  revision: 2,
  draftThreadId: "reserved-thread-1",
  usedThreadId: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
});

beforeEach(() => {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
});

it("reuses the reserved draft without replacing edits or another project's draft", () => {
  const store = useComposerDraftStore.getState();
  const unrelatedId = DraftId.make("unrelated-draft");
  store.setLogicalProjectDraftThreadId("unrelated", otherProjectRef, unrelatedId, {
    threadId: ThreadId.make("unrelated-thread"),
  });
  store.setPrompt(unrelatedId, "Keep this separate work.");
  const selection: ModelSelection = {
    instanceId: "codex" as ModelSelection["instanceId"],
    model: "gpt-6.1-sol",
  };

  const first = prepareSuggestionDraft(projectRef, suggestion, selection);
  expect(first.kind).toBe("draft");
  if (first.kind !== "draft") return;
  const created = store.getDraftSession(first.draftId);
  expect(created).toMatchObject({
    environmentId,
    projectId: projectRef.projectId,
    threadId: suggestion.draftThreadId,
  });
  expect(store.getComposerDraft(first.draftId)?.prompt).toBe(suggestion.prompt);
  expect(
    store.getComposerDraft(first.draftId)?.modelSelectionByProvider[selection.instanceId]?.model,
  ).toBe("gpt-6.1-sol");

  store.setPrompt(first.draftId, "My edited prompt survives another Use click.");
  const second = prepareSuggestionDraft(
    projectRef,
    { ...suggestion, prompt: "New generated text" },
    null,
  );
  expect(second).toEqual(first);
  expect(store.getComposerDraft(first.draftId)?.prompt).toBe(
    "My edited prompt survives another Use click.",
  );
  expect(store.getComposerDraft(unrelatedId)?.prompt).toBe("Keep this separate work.");
  expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(2);
  const persistence = useComposerDraftStore.persist.getOptions();
  const state = useComposerDraftStore.getState();
  const restored = persistence.merge!(partializeComposerDraftStoreState(state), state);
  expect(restored.draftThreadsByThreadKey[first.draftId]).toMatchObject({
    environmentId,
    projectId: projectRef.projectId,
    threadId: suggestion.draftThreadId,
  });
  expect(restored.draftsByThreadKey[first.draftId]?.prompt).toBe(
    "My edited prompt survives another Use click.",
  );
});

it("rejects a suggestion or draft whose project identity does not match", () => {
  expect(() => prepareSuggestionDraft(otherProjectRef, suggestion, null)).toThrow(/not ready/);
  expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);

  const collidingId = DraftId.make(
    `monarch-suggestion-${encodeURIComponent(environmentId)}-${encodeURIComponent(suggestion.id)}`,
  );
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId("collision", otherProjectRef, collidingId, {
    threadId: suggestion.draftThreadId!,
  });
  store.setPrompt(collidingId, "Do not overwrite me.");
  expect(() => prepareSuggestionDraft(projectRef, suggestion, null)).toThrow(/no longer matches/);
  expect(store.getComposerDraft(collidingId)?.prompt).toBe("Do not overwrite me.");
});

it("navigates to the promoted thread when Use is repeated after submission", () => {
  const first = prepareSuggestionDraft(projectRef, suggestion, null);
  expect(first.kind).toBe("draft");
  if (first.kind !== "draft") return;
  const threadRef = scopeThreadRef(environmentId, suggestion.draftThreadId!);
  useComposerDraftStore.getState().markDraftThreadPromoting(first.draftId, threadRef);
  expect(prepareSuggestionDraft(projectRef, suggestion, null)).toEqual({
    kind: "server",
    threadRef,
  });
});
