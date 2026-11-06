import type { NextThreadSuggestion } from "@t3tools/contracts";
import { ChevronDownIcon, PencilIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";

export function ProjectSuggestionTab({
  suggestion,
  composerOpen,
  references,
  canEdit,
  busy,
  reasons,
  editor,
  onOpen,
  onEdit,
  onRemove,
  onRestore,
}: {
  suggestion: NextThreadSuggestion;
  composerOpen: boolean;
  references: ReactNode;
  canEdit: boolean;
  busy: boolean;
  reasons: readonly string[];
  editor: ReactNode;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRestore: () => void;
}) {
  const proposed = suggestion.status === "suggested";
  const material = (
    <>
      {suggestion.rationale && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-secondary-label">
          {suggestion.rationale}
        </p>
      )}
      {references}
      {reasons.length > 0 && (
        <div
          className="space-y-1 text-xs text-warning-foreground"
          aria-label="Proposal review reasons"
        >
          {reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!composerOpen && suggestion.status !== "dismissed" && (
          <Button
            size="sm"
            disabled={busy || (proposed && (!canEdit || reasons.length > 0))}
            onClick={onOpen}
          >
            {proposed ? "Open draft" : "Open thread"}
          </Button>
        )}
        {proposed && (
          <>
            <Button size="sm" variant="outline" disabled={!canEdit || busy} onClick={onEdit}>
              <PencilIcon />
              Edit suggestion
            </Button>
            <Button size="sm" variant="ghost-muted" disabled={!canEdit || busy} onClick={onRemove}>
              Remove
            </Button>
          </>
        )}
        {suggestion.status === "dismissed" && (
          <Button size="sm" variant="outline" disabled={!canEdit || busy} onClick={onRestore}>
            Restore suggestion
          </Button>
        )}
      </div>
    </>
  );
  if (composerOpen)
    return (
      <section
        className="max-h-[35cqh] overflow-y-auto border-b border-border px-4 py-2"
        aria-label="Suggested thread context"
      >
        {editor ?? (
          <details>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground">
              <SparklesIcon className="size-3.5" />
              Suggestion details
              <ChevronDownIcon className="size-3.5" />
            </summary>
            <div className="mt-3 space-y-3 pb-2">{material}</div>
          </details>
        )}
      </section>
    );
  return (
    <article className="mx-auto w-full max-w-2xl space-y-5 px-5 py-6" aria-label="Suggested thread">
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <SparklesIcon className="size-4" />
          {suggestion.status === "dismissed" ? "Removed suggestion" : "Suggested thread"}
        </p>
        <h2 className="text-xl font-semibold tracking-tight">{suggestion.title}</h2>
      </div>
      {editor ?? (
        <>
          <div className="space-y-3">{material}</div>
          <section className="space-y-2 border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground">Proposed prompt</h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {suggestion.prompt}
            </p>
          </section>
        </>
      )}
    </article>
  );
}
