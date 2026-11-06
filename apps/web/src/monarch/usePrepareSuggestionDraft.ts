import type { NextThreadSuggestion, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useReserveSuggestionDraft } from "./useOpenSuggestionDraft";

export function usePrepareSuggestionDraft(projectRef: ScopedProjectRef) {
  const navigate = useNavigate();
  const reserveDraft = useReserveSuggestionDraft();
  const inFlight = useRef(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prepare = (suggestion: NextThreadSuggestion) => {
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setPreparingId(suggestion.id);
    setError(null);
    return reserveDraft(projectRef, suggestion)
      .then(async (target) => {
        if (target.kind === "server") {
          await navigate({ to: "/$environmentId/$threadId", params: target.threadRef });
        } else {
          await navigate({ to: "/draft/$draftId", params: { draftId: target.draftId } });
        }
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not prepare this suggested thread. Try again.",
        );
      })
      .finally(() => {
        inFlight.current = false;
        setPreparingId(null);
      });
  };
  return { prepare, preparingId, error };
}
