import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ModelSelection, NextThreadSuggestion, ScopedProjectRef } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";

export function prepareSuggestionDraft(
  projectRef: ScopedProjectRef,
  suggestion: NextThreadSuggestion,
  modelSelection: ModelSelection | null,
) {
  if (suggestion.projectId !== projectRef.projectId || suggestion.draftThreadId === null) {
    throw new Error("This suggestion is not ready for a draft in this project.");
  }
  const threadRef = scopeThreadRef(projectRef.environmentId, suggestion.draftThreadId);
  if (suggestion.usedThreadId !== null || readThreadShell(threadRef) !== null) {
    return { kind: "server", threadRef } as const;
  }
  // Persisted draft keys with colons are interpreted as legacy environment/thread pairs.
  const draftId = DraftId.make(
    `monarch-suggestion-${encodeURIComponent(projectRef.environmentId)}-${encodeURIComponent(suggestion.id)}`,
  );
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
