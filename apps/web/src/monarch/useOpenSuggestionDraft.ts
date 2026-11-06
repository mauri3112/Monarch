import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NextThreadSuggestion, ScopedProjectRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { useProject } from "../state/entities";
import { monarchEnvironment } from "../state/monarch";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { ThreadRouteTarget } from "../threadRoutes";
import { prepareSuggestionDraft } from "./suggestionDraft";
import { suggestionReviewReasons } from "./suggestionReview";

export function useReserveSuggestionDraft() {
  const registry = useContext(RegistryContext);
  const reserve = useAtomCommand(monarchEnvironment.prepareSuggestion, { reportFailure: false });
  return async (projectRef: ScopedProjectRef, suggestion: NextThreadSuggestion) => {
    const { environmentId, projectId } = projectRef;
    const result = await reserve({
      environmentId,
      input: { projectId, id: suggestion.id, expectedRevision: suggestion.revision },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    const selection = config
      ? resolveProjectDefaultProviderModelSelection(config.providers, config.settings, projectId)
      : null;
    return prepareSuggestionDraft(
      projectRef,
      result.value,
      selection ?? suggestion.modelSelection ?? null,
    );
  };
}

export function useOpenSuggestionDraft(projectRef: ScopedProjectRef | null) {
  const registry = useContext(RegistryContext);
  const project = useProject(projectRef);
  const reserveDraft = useReserveSuggestionDraft();
  async function resolveSuggestion(id: string): Promise<ThreadRouteTarget | null> {
    if (!projectRef) return null;
    const { environmentId, projectId } = projectRef;
    const args = { environmentId, input: { projectId } };
    const planning = await Effect.runPromise(
      AtomRegistry.getResult(
        registry,
        monarchEnvironment.projectState({ ...args, input: { projectId, focusSuggestionId: id } }),
      ),
    );
    const item = planning.suggestions.find((candidate) => candidate.id === id);
    if (!item) return null;
    if (item.status === "used" && item.usedThreadId)
      return { kind: "server", threadRef: scopeThreadRef(environmentId, item.usedThreadId) };
    if (
      !project ||
      project.archivedAt ||
      item.status !== "suggested" ||
      !registry.get(monarchEnvironment.prepareSuggestion.permissionAtom(environmentId))
    )
      return null;
    const context = await Effect.runPromise(
      AtomRegistry.getResult(registry, monarchEnvironment.context.live(args)),
    );
    if (suggestionReviewReasons(item, planning.targets, context).length) return null;
    return reserveDraft(projectRef, item);
  }
  return { resolveSuggestion };
}
