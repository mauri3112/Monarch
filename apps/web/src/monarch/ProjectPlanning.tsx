import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  MonarchTarget,
  MonarchTargetStatus,
  NextThreadSuggestion,
  ScopedProjectRef,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { monarchEnvironment } from "../state/monarch";
import { useQuietThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { usePrepareSuggestionDraft } from "./usePrepareSuggestionDraft";
import { ProjectSchedules } from "./ProjectSchedules";

const STATUS_LABEL: Record<MonarchTargetStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  achieved: "Achieved",
  archived: "Archived",
};
const splitNotes = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function ProjectPlanning({
  projectRef,
  archived,
  children,
}: {
  projectRef: ScopedProjectRef;
  archived: boolean;
  children?: ReactNode;
}) {
  const query = useEnvironmentQuery(
    monarchEnvironment.projectState({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const canEdit =
    useAtomValue(monarchEnvironment.createTarget.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const canAcknowledgeUsed = useAtomValue(
    monarchEnvironment.markSuggestionUsed.permissionAtom(projectRef.environmentId),
  );
  const createTarget = useAtomCommand(monarchEnvironment.createTarget, {
    label: "create project target",
  });
  const updateTarget = useAtomCommand(monarchEnvironment.updateTarget, {
    label: "update project target",
  });
  const updateSuggestion = useAtomCommand(monarchEnvironment.updateSuggestion, {
    label: "edit suggested thread",
  });
  const setSuggestionStatus = useAtomCommand(monarchEnvironment.setSuggestionStatus, {
    label: "set suggested thread status",
  });
  const markSuggestionUsed = useAtomCommand(monarchEnvironment.markSuggestionUsed, {
    label: "record used suggested thread",
  });
  const draft = usePrepareSuggestionDraft(projectRef);
  const threadShells = useQuietThreadShells();
  const usedAcknowledgements = useRef(new Set<string>());
  const [editingTarget, setEditingTarget] = useState<MonarchTarget | "new" | null>(null);
  const [editingSuggestion, setEditingSuggestion] = useState<NextThreadSuggestion | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedUsedAcknowledgement, setFailedUsedAcknowledgement] = useState<string | null>(null);
  const targets = query.data?.targets.filter((target) => target.status !== "archived") ?? [];
  const archivedTargets =
    query.data?.targets.filter((target) => target.status === "archived") ?? [];
  const suggestions = query.data?.suggestions.filter((item) => item.status === "suggested") ?? [];
  const removedSuggestions =
    query.data?.suggestions.filter((item) => item.status === "dismissed") ?? [];
  const usedSuggestions = query.data?.suggestions.filter((item) => item.status === "used") ?? [];
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const { environmentId, projectId } = projectRef;
  const stateSuggestions = query.data?.suggestions;
  const refreshPlanning = query.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persisted threads confirm whether a prepared draft became used work
  useEffect(() => {
    if (!canAcknowledgeUsed) return;
    for (const item of stateSuggestions ?? []) {
      if (item.status !== "suggested" || !item.draftThreadId) continue;
      const shell = threadShells.find(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.projectId === projectId &&
          thread.id === item.draftThreadId,
      );
      if (!shell) continue;
      const key = `${item.id}:${item.revision}`;
      if (usedAcknowledgements.current.has(key)) continue;
      usedAcknowledgements.current.add(key);
      void markSuggestionUsed({
        environmentId,
        input: {
          projectId,
          id: item.id,
          expectedRevision: item.revision,
          threadId: shell.id,
        },
      }).then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setFailedUsedAcknowledgement(key);
            setError(
              `Could not record used suggestion: ${String(squashAtomCommandFailure(result))}`,
            );
          }
          return;
        }
        refreshPlanning();
      });
    }
  }, [
    stateSuggestions,
    refreshPlanning,
    markSuggestionUsed,
    threadShells,
    environmentId,
    projectId,
    canAcknowledgeUsed,
  ]);

  async function saveTarget(input: {
    title: string;
    description: string;
    indicators: string[];
    constraints: string[];
    status: MonarchTargetStatus;
  }) {
    const item = editingTarget;
    if (!item) return;
    setBusyId("target");
    setError(null);
    const result =
      item === "new"
        ? await createTarget({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, ...input },
          })
        : await updateTarget({
            environmentId: projectRef.environmentId,
            input: {
              projectId: projectRef.projectId,
              id: item.id,
              expectedRevision: item.revision,
              ...input,
            },
          });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setEditingTarget(null);
    query.refresh();
  }

  async function saveSuggestion(input: {
    title: string;
    prompt: string;
    targets?: NextThreadSuggestion["targets"];
  }) {
    if (!editingSuggestion) return;
    setBusyId(editingSuggestion.id);
    setError(null);
    const result = await updateSuggestion({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        id: editingSuggestion.id,
        expectedRevision: editingSuggestion.revision,
        ...input,
      },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setEditingSuggestion(null);
    query.refresh();
  }

  async function changeSuggestionStatus(
    item: NextThreadSuggestion,
    status: "suggested" | "dismissed",
  ) {
    setBusyId(item.id);
    setError(null);
    const result = await setSuggestionStatus({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        id: item.id,
        expectedRevision: item.revision,
        status,
      },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    query.refresh();
  }

  return (
    <div className="space-y-8">
      {query.error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          Could not load project planning: {query.error}{" "}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}{" "}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Refresh
          </Button>
          {failedUsedAcknowledgement ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                usedAcknowledgements.current.delete(failedUsedAcknowledgement);
                setFailedUsedAcknowledgement(null);
                setError(null);
                query.refresh();
              }}
            >
              Retry recording use
            </Button>
          ) : null}
        </p>
      ) : null}
      {draft.error ? (
        <p role="alert" className="text-xs text-destructive">
          {draft.error}{" "}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Refresh project
          </Button>
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading project planning…
        </p>
      ) : null}
      <section aria-labelledby="monarch-targets-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="monarch-targets-heading" className="text-base font-medium tracking-tight">
              Targets
            </h2>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => setEditingTarget("new")}
          >
            <PlusIcon /> Add target
          </Button>
        </div>
        {editingTarget ? (
          <TargetEditor
            key={editingTarget === "new" ? "new" : editingTarget.id}
            target={editingTarget === "new" ? null : editingTarget}
            busy={busyId === "target"}
            onSave={(input) => void saveTarget(input)}
            onCancel={() => setEditingTarget(null)}
          />
        ) : null}
        {query.data && targets.length === 0 && !editingTarget ? (
          <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5">
            <p className="text-sm font-medium">Set a direction</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Describe what you want this project to achieve.
            </p>
          </div>
        ) : null}
        {targets.length > 0 ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-2.5">
            {targets.map((target) => (
              <article
                key={target.id}
                className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="rounded-full border border-border px-2 py-0.5 text-3xs text-muted-foreground">
                    {STATUS_LABEL[target.status]}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit target ${target.title}`}
                    disabled={!canEdit}
                    onClick={() => setEditingTarget(target)}
                  >
                    <PencilIcon />
                  </Button>
                </div>
                <h3 className="mt-3 text-sm font-medium leading-snug break-words">
                  {target.title}
                </h3>
                {target.description ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground break-words">
                    {target.description}
                  </p>
                ) : null}
                {target.indicators.length ? (
                  <p className="mt-auto pt-3 text-2xs text-muted-foreground">
                    Signs of progress · {target.indicators.join(" · ")}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
        {archivedTargets.length ? (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Archived Targets ({archivedTargets.length})
            </summary>
            <div className="mt-2 space-y-2">
              {archivedTargets.map((target) => (
                <div
                  key={target.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <span className="min-w-0 truncate">{target.title}</span>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!canEdit}
                    onClick={() => setEditingTarget(target)}
                  >
                    <RotateCcwIcon /> Edit or restore
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
      {children}
      <section
        aria-labelledby="monarch-suggestions-heading"
        className="border-t border-border pt-7"
      >
        <div>
          <h2 id="monarch-suggestions-heading" className="text-base font-medium tracking-tight">
            Suggested next threads
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Use opens a draft for you to edit and send.
          </p>
        </div>
        {query.data && suggestions.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5">
            <p className="text-sm font-medium">No suggestions to review</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Schedule suggestions to find next steps from your Targets and recent threads.
            </p>
          </div>
        ) : null}
        {suggestions.length ? (
          <div className="mt-4 space-y-2.5">
            {suggestions.map((item) => {
              const stale = item.targets.some(
                (ref) => targetById.get(ref.targetId)?.revision !== ref.revision,
              );
              return (
                <article
                  key={item.id}
                  className="rounded-xl border border-warning/30 bg-warning-surface/40 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-warning/12 px-2 py-0.5 text-3xs font-medium text-warning-foreground">
                      SUGGESTED
                    </span>
                    {stale ? (
                      <span className="text-3xs text-warning-foreground">
                        Needs review after a Target changed
                      </span>
                    ) : null}
                  </div>
                  <h3 className="mt-2.5 text-sm font-medium leading-snug break-words">
                    {item.title}
                  </h3>
                  {item.rationale ? (
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground break-words">
                      {item.rationale}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                    {item.targets.map((ref) => (
                      <span key={ref.targetId}>
                        Target: {targetById.get(ref.targetId)?.title ?? "Unavailable"}
                      </span>
                    ))}
                    {item.sourceThreadIds.map((id) => (
                      <Link
                        key={id}
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(projectRef.environmentId, id),
                        )}
                        className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                      >
                        Source thread <ArrowUpRightIcon size={11} aria-hidden="true" />
                      </Link>
                    ))}
                  </div>
                  {stale ? (
                    <p className="mt-2 text-xs text-warning-foreground">
                      A referenced Target changed. Review the prompt and update its Target
                      references before using this suggestion, or remove it and generate new
                      suggestions.
                    </p>
                  ) : null}
                  {item.draftThreadId ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      An editable draft is ready. Changes to this suggestion will not replace text
                      already in the draft.
                    </p>
                  ) : null}
                  {editingSuggestion?.id === item.id ? (
                    <SuggestionEditor
                      suggestion={item}
                      currentTargets={targetById}
                      stale={stale}
                      busy={busyId === item.id}
                      onSave={(input) => void saveSuggestion(input)}
                      onCancel={() => setEditingSuggestion(null)}
                    />
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-warning/20 pt-3">
                    <Button
                      size="xs"
                      disabled={stale || !canEdit || draft.preparingId === item.id}
                      onClick={() => void draft.prepare(item)}
                    >
                      <CheckIcon />{" "}
                      {draft.preparingId === item.id
                        ? "Opening…"
                        : item.draftThreadId
                          ? "Continue draft"
                          : "Use"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!canEdit}
                      onClick={() => setEditingSuggestion(item)}
                    >
                      <PencilIcon /> Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!canEdit || busyId === item.id}
                      onClick={() => void changeSuggestionStatus(item, "dismissed")}
                    >
                      <XIcon /> Remove
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {removedSuggestions.length ? (
          <details className="mt-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Removed suggestions ({removedSuggestions.length})
            </summary>
            <div className="mt-2 space-y-2">
              {removedSuggestions.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <span className="min-w-0 truncate">{item.title}</span>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!canEdit || busyId === item.id}
                    onClick={() => void changeSuggestionStatus(item, "suggested")}
                  >
                    <RotateCcwIcon /> Restore
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {usedSuggestions.length ? (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Used suggestions ({usedSuggestions.length})
            </summary>
            <div className="mt-2 space-y-2">
              {usedSuggestions.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <span className="min-w-0 truncate">{item.title}</span>
                  {item.usedThreadId ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(projectRef.environmentId, item.usedThreadId),
                      )}
                      className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:underline"
                    >
                      Open thread <ArrowUpRightIcon size={11} aria-hidden="true" />
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {query.data?.hasMoreHistory ? (
          <p className="mt-3 text-2xs text-muted-foreground">
            Showing the latest 100 used or removed suggestions.
          </p>
        ) : null}
      </section>
      <ProjectSchedules projectRef={projectRef} archived={archived} />
    </div>
  );
}

function TargetEditor({
  target,
  busy,
  onSave,
  onCancel,
}: {
  target: MonarchTarget | null;
  busy: boolean;
  onSave: (value: {
    title: string;
    description: string;
    indicators: string[];
    constraints: string[];
    status: MonarchTargetStatus;
  }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(target?.title ?? "");
  const [description, setDescription] = useState(target?.description ?? "");
  const [indicators, setIndicators] = useState(target?.indicators.join("\n") ?? "");
  const [constraints, setConstraints] = useState(target?.constraints.join("\n") ?? "");
  const [status, setStatus] = useState<MonarchTargetStatus>(target?.status ?? "active");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim())
      onSave({
        title: title.trim(),
        description: description.trim(),
        indicators: splitNotes(indicators),
        constraints: splitNotes(constraints),
        status,
      });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-3 rounded-xl border border-border bg-muted/25 p-4"
    >
      <h3 className="text-sm font-medium">{target ? "Edit Target" : "New Target"}</h3>
      <label className="block space-y-1 text-xs font-medium">
        Title
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
          placeholder="What direction matters?"
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Description
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={16000}
          placeholder="Describe the outcome you want to move toward."
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Signs of progress <span className="font-normal text-muted-foreground">(one per line)</span>
        <Textarea
          size="sm"
          value={indicators}
          onChange={(event) => setIndicators(event.target.value)}
          placeholder="What would show progress?"
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Constraints <span className="font-normal text-muted-foreground">(one per line)</span>
        <Textarea
          size="sm"
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
          placeholder="What should stay within bounds?"
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Status
        <select
          className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value as MonarchTargetStatus)}
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || !title.trim()}>
          Save Target
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SuggestionEditor({
  suggestion,
  currentTargets,
  stale,
  busy,
  onSave,
  onCancel,
}: {
  suggestion: NextThreadSuggestion;
  currentTargets: ReadonlyMap<string, MonarchTarget>;
  stale: boolean;
  busy: boolean;
  onSave: (value: {
    title: string;
    prompt: string;
    targets?: NextThreadSuggestion["targets"];
  }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(suggestion.title);
  const [prompt, setPrompt] = useState(suggestion.prompt);
  const [useCurrentTargets, setUseCurrentTargets] = useState(false);
  const canRebase = suggestion.targets.every(
    (reference) => currentTargets.get(reference.targetId)?.status === "active",
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && prompt.trim())
      onSave({
        title: title.trim(),
        prompt: prompt.trim(),
        ...(useCurrentTargets
          ? {
              targets: suggestion.targets.map((reference) => ({
                targetId: reference.targetId,
                revision: currentTargets.get(reference.targetId)!.revision,
              })),
            }
          : {}),
      });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-3 rounded-lg border border-warning/25 bg-background p-3"
    >
      <label className="block space-y-1 text-xs font-medium">
        Thread title
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Draft prompt
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          maxLength={32000}
          required
        />
      </label>
      {stale && canRebase ? (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={useCurrentTargets}
            onChange={(event) => setUseCurrentTargets(event.target.checked)}
          />
          <span>
            I reviewed this prompt against the current Target versions. Update its references so it
            can be used.
          </span>
        </label>
      ) : null}
      {stale && !canRebase ? (
        <p className="text-xs text-warning-foreground">
          A referenced Target is no longer active. Reactivate it, or remove this suggestion and run
          a new project review.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="xs" type="submit" disabled={busy || !title.trim() || !prompt.trim()}>
          Save edit
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
