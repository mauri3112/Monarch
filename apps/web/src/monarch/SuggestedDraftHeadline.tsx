import type { ScopedProjectRef } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";

export function SuggestedDraftHeadline({
  projectRef,
  suggestionId,
}: {
  projectRef: ScopedProjectRef;
  suggestionId: string;
}) {
  const planning = useEnvironmentQuery(
    monarchEnvironment.projectState({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, focusSuggestionId: suggestionId },
    }),
  );
  const item = planning.data?.suggestions.find((s) => s.id === suggestionId);
  return (
    <div className="mx-auto max-w-xl px-4 text-center" data-monarch-suggestion-hero>
      <div className="mb-2 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        Suggested thread
      </div>
      <h2 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
        {item?.title ?? "Thread draft"}
      </h2>
      {item?.rationale && (
        <p className="mx-auto mt-2 line-clamp-3 max-w-prose text-pretty text-sm leading-relaxed text-muted-foreground">
          {item.rationale}
        </p>
      )}
    </div>
  );
}
