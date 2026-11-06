import type { MonarchContextState, MonarchTarget, NextThreadSuggestion } from "@t3tools/contracts";

export function suggestionReviewReasons(
  item: NextThreadSuggestion,
  targets: readonly MonarchTarget[],
  context: MonarchContextState | null,
) {
  const reasons = new Set<string>();
  for (const ref of item.targets) {
    const target = targets.find((candidate) => candidate.id === ref.targetId);
    if (!target) reasons.add("A referenced Target is unavailable.");
    else if (target.status !== "active")
      reasons.add(`Target “${target.title}” is ${target.status}.`);
    else if (target.revision !== ref.revision)
      reasons.add(
        `Target “${target.title}” changed from revision ${ref.revision} to ${target.revision}.`,
      );
  }
  if (item.contextRevision !== undefined && item.contextRevision !== context?.revision) {
    reasons.add(
      context
        ? `Project context changed from revision ${item.contextRevision} to ${context.revision}.`
        : "Loading the current project context.",
    );
  }
  if (item.sourceThreadIds.some((id) => context?.settings.excludedThreadIds.includes(id)))
    reasons.add("A source thread is excluded from this project’s reviews.");
  return [...reasons];
}
