import type { ScopedProjectRef } from "@t3tools/contracts";
import { DraftId } from "../composerDraftStore";

function idPrefix(ref: ScopedProjectRef) {
  return `monarch-suggestion-${encodeURIComponent(ref.environmentId)}-`;
}

export function suggestionDraftId(ref: ScopedProjectRef, suggestionId: string) {
  // Colons in persisted draft keys are interpreted as legacy environment/thread pairs.
  return DraftId.make(idPrefix(ref) + encodeURIComponent(suggestionId));
}

export function suggestionIdForDraft(ref: ScopedProjectRef, draftId: DraftId): string | null {
  const prefix = idPrefix(ref);
  if (!draftId.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(draftId.slice(prefix.length)) || null;
  } catch {
    return null;
  }
}
