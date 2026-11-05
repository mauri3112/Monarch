import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NextThreadSuggestion, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { monarchEnvironment } from "../state/monarch";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { prepareSuggestionDraft } from "./suggestionDraft";

export function usePrepareSuggestionDraft(projectRef: ScopedProjectRef) {
  const navigate = useNavigate();
  const config = useAtomValue(serverEnvironment.configValueAtom(projectRef.environmentId));
  const reserve = useAtomCommand(monarchEnvironment.prepareSuggestion, { reportFailure: false });
  const inFlight = useRef(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prepare = (suggestion: NextThreadSuggestion) => {
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setPreparingId(suggestion.id);
    setError(null);
    return reserve({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        id: suggestion.id,
        expectedRevision: suggestion.revision,
      },
    })
      .then(async (result) => {
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not prepare this suggested thread. Try again.",
          );
          return;
        }
        const selection = config
          ? resolveProjectDefaultProviderModelSelection(
              config.providers,
              config.settings,
              projectRef.projectId,
            )
          : null;
        const target = prepareSuggestionDraft(
          projectRef,
          result.value,
          selection ?? suggestion.modelSelection ?? null,
        );
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
