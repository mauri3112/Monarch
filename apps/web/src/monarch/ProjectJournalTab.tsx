import {
  RunId,
  type MonarchGeneratedContextEntry,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { MessagesSquareIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";

const kindLabels: Record<MonarchGeneratedContextEntry["kind"], string> = {
  decision: "Decision",
  outcome: "Outcome",
  question: "Open question",
  overview: "Overview",
  architecture: "Architecture",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function RecordedTime({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at}>{Number.isNaN(date.getTime()) ? at : dateFormatter.format(date)}</time>
  );
}

export function ProjectJournalTab({
  projectRef,
  runId,
  revision,
  onOpenThread,
}: {
  projectRef: ScopedProjectRef;
  runId: string;
  revision: number;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const query = useEnvironmentQuery(
    monarchEnvironment.timeline.journal({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, runId: RunId.make(runId), revision },
    }),
  );
  if (query.error) {
    return (
      <div className="space-y-2 p-4">
        <p role="alert" className="text-sm">
          Could not load the journal. {query.error}
        </p>
        <Button size="xs" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (!query.data)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading journal…
      </p>
    );
  const journal = query.data.journal;
  if (
    !journal ||
    journal.projectId !== projectRef.projectId ||
    journal.runId !== runId ||
    journal.revision !== revision
  ) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Journal revision {revision} is unavailable in this project.
      </p>
    );
  }
  const effort = REASONING_EFFORT_OPTION_IDS.map((id) =>
    getModelSelectionStringOptionValue(journal.modelSelection, id),
  ).find(Boolean);

  return (
    <article
      aria-label="Run journal"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm"
    >
      <header className="mb-4">
        <p className="text-xs text-muted-foreground">Journal · Revision {journal.revision}</p>
        <h2 className="mt-1 break-words text-base font-semibold leading-snug">
          {journal.threadTitle}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Turn completed <RecordedTime at={journal.completedAt} />
        </p>
        <div className="mt-3">
          <Button variant="outline" size="xs" onClick={() => onOpenThread(journal.threadId)}>
            <MessagesSquareIcon aria-hidden="true" />
            Open source thread
          </Button>
        </div>
      </header>
      {journal.entries.length ? (
        <ul aria-label="Journal entries" className="divide-y divide-border border-y border-border">
          {journal.entries.map((entry, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- entries have no ID and their order is immutable within the saved revision
            <li key={index} className="space-y-1 py-3">
              <p className="text-xs text-muted-foreground">
                {kindLabels[entry.kind]}
                {entry.scope === "branch" && entry.branch ? ` · ${entry.branch}` : ""}
              </p>
              <h3 className="break-words font-medium leading-snug">{entry.title}</h3>
              <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-y border-border py-4 text-muted-foreground">
          This revision recorded no journal entries for the turn.
        </p>
      )}
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Recorded</dt>
        <dd>
          <RecordedTime at={journal.recordedAt} />
        </dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="break-all">{journal.modelSelection.model}</dd>
        {effort ? (
          <>
            <dt className="text-muted-foreground">Reasoning effort</dt>
            <dd>{effort}</dd>
          </>
        ) : null}
        {journal.branch ? (
          <>
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="break-all">{journal.branch}</dd>
          </>
        ) : null}
        {journal.worktreePath ? (
          <>
            <dt className="text-muted-foreground">Worktree</dt>
            <dd className="break-all">{journal.worktreePath}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}
