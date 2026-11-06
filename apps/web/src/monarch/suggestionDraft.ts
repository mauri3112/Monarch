import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ModelSelection, NextThreadSuggestion, ScopedProjectRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";

import { suggestionDraftId } from "./suggestionDraftIdentity";

export function hasSuggestionMessage(
  shell: Pick<EnvironmentThreadShell, "latestUserAuthoredMessageAt" | "latestUserMessageAt">,
) {
  return Boolean(
    shell.latestUserAuthoredMessageAt === undefined
      ? shell.latestUserMessageAt
      : shell.latestUserAuthoredMessageAt,
  );
}

export function updateUneditedSuggestionPrompt(
  projectRef: ScopedProjectRef,
  suggestion: NextThreadSuggestion,
  prompt: string,
) {
  const id = suggestionDraftId(projectRef, suggestion.id);
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(id);
  if (
    session &&
    !session.promotedTo &&
    session.environmentId === projectRef.environmentId &&
    session.projectId === projectRef.projectId &&
    session.threadId === suggestion.draftThreadId &&
    store.getComposerDraft(id)?.prompt === suggestion.prompt
  )
    store.setPrompt(id, prompt);
}

export function prepareSuggestionDraft(
  projectRef: ScopedProjectRef,
  suggestion: NextThreadSuggestion,
  modelSelection: ModelSelection | null,
) {
  if (suggestion.projectId !== projectRef.projectId || suggestion.draftThreadId === null) {
    throw new Error("This suggestion is not ready for a draft in this project.");
  }
  const threadRef = scopeThreadRef(projectRef.environmentId, suggestion.draftThreadId);
  const shell = readThreadShell(threadRef);
  if (suggestion.usedThreadId !== null)
    return {
      kind: "server",
      threadRef: scopeThreadRef(projectRef.environmentId, suggestion.usedThreadId),
    } as const;
  if (shell && hasSuggestionMessage(shell)) return { kind: "server", threadRef } as const;
  const draftId = suggestionDraftId(projectRef, suggestion.id);
  const store = useComposerDraftStore.getState();
  const existing = store.getDraftSession(draftId);
  if (existing !== null) {
    if (
      existing.environmentId !== projectRef.environmentId ||
      existing.projectId !== projectRef.projectId ||
      existing.threadId !== suggestion.draftThreadId
    ) {
      throw new Error("This suggestion's draft no longer matches the project.");
    }
    if (existing.promotedTo != null)
      return { kind: "server", threadRef: existing.promotedTo } as const;
    return { kind: "draft", draftId } as const;
  }
  store.setLogicalProjectDraftThreadId(
    `monarch-suggestion:${scopedProjectKey(projectRef)}:${suggestion.id}`,
    projectRef,
    draftId,
    { threadId: suggestion.draftThreadId, runtimeMode: "approval-required", envMode: "local" },
  );
  store.applyStickyState(draftId);
  if (modelSelection) store.setModelSelection(draftId, modelSelection, { replaceOptions: true });
  store.setPrompt(draftId, suggestion.prompt);
  return { kind: "draft", draftId } as const;
}
