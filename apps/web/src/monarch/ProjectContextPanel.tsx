import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { MonarchContextEntry, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  HistoryIcon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useQuietThreadShells } from "../state/entities";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { MonarchPanelShell } from "./MonarchPanelShell";

const KINDS = ["overview", "architecture", "decision", "question", "outcome"] as const;
const KIND_LABEL: Record<MonarchContextEntry["kind"], string> = {
  overview: "Overview",
  architecture: "Architecture",
  decision: "Decision",
  question: "Open question",
  outcome: "Outcome",
};

export function ProjectContextPanel({
  projectRef,
  projectTitle,
  open,
  onClose,
  archived,
  presentation,
}: {
  projectRef: ScopedProjectRef;
  projectTitle: string;
  open: boolean;
  onClose: () => void;
  archived: boolean;
  presentation?: "sheet" | "docked";
}) {
  const stateQuery = useEnvironmentQuery(
    monarchEnvironment.context.live({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const sourcesQuery = useEnvironmentQuery(
    monarchEnvironment.continuity.sources({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const refreshSources = sourcesQuery.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidate the cached remote source list whenever this panel opens
  useEffect(() => {
    if (open) refreshSources();
  }, [open, refreshSources]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [latestHistoryEntries, setLatestHistoryEntries] = useState<
    ReadonlyMap<string, MonarchContextEntry>
  >(new Map());
  const historyQuery = useEnvironmentQuery(
    historyOpen
      ? monarchEnvironment.context.history({
          environmentId: projectRef.environmentId,
          input: {
            projectId: projectRef.projectId,
            ...(historyBefore ? { beforeSequence: historyBefore } : {}),
          },
        })
      : null,
  );
  const canEdit =
    useAtomValue(monarchEnvironment.context.upsertEntry.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const canConfigure =
    useAtomValue(
      monarchEnvironment.context.updateSettings.permissionAtom(projectRef.environmentId),
    ) && !archived;
  const canBuild =
    useAtomValue(monarchEnvironment.continuity.refresh.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const updateSettings = useAtomCommand(monarchEnvironment.context.updateSettings, {
    label: "save project brief",
  });
  const upsertEntry = useAtomCommand(monarchEnvironment.context.upsertEntry, {
    label: "save project context entry",
  });
  const removeEntry = useAtomCommand(monarchEnvironment.context.removeEntry, {
    label: "remove project context entry",
  });
  const restoreEntry = useAtomCommand(monarchEnvironment.context.restoreEntry, {
    label: "restore project context entry",
  });
  const refresh = useAtomCommand(monarchEnvironment.continuity.refresh, {
    label: "build project context",
  });
  const threadShells = useQuietThreadShells();
  const threadNames = new Map(
    threadShells
      .filter(
        (thread) =>
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      )
      .map((thread) => [thread.id, thread.title]),
  );
  const [editingBrief, setEditingBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState("");
  const [editingEntry, setEditingEntry] = useState<MonarchContextEntry | "new" | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<ThreadId> | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = stateQuery.data;
  const sources = sourcesQuery.data?.sources ?? [];
  const availableSourceIds = new Set(
    sources
      .filter(
        (source) =>
          !source.excluded && !state?.settings.excludedThreadIds.includes(source.threadId),
      )
      .map((source) => source.threadId),
  );
  const selected =
    selectedSourceIds ??
    new Set(
      sources
        .filter((source) => availableSourceIds.has(source.threadId))
        .slice(0, 20)
        .map((source) => source.threadId),
    );
  const validSelected = [...selected].filter((id) => availableSourceIds.has(id)).slice(0, 20);
  const entries = (state?.entries ?? [])
    .filter((entry) => entry.removedAt === null)
    .toSorted(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const historyItems = historyQuery.data?.items ?? [];

  const rememberHistoryPage = () => {
    setLatestHistoryEntries((current) => {
      const next = new Map(current);
      for (const item of historyItems) {
        if (!next.has(item.entry.id)) next.set(item.entry.id, item.entry);
      }
      return next;
    });
  };

  async function runMutation<A, E>(action: string, task: () => Promise<AtomCommandResult<A, E>>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    const result = await task();
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return false;
    }
    setLatestHistoryEntries(new Map());
    setHistoryBefore(null);
    stateQuery.refresh();
    historyQuery.refresh();
    return true;
  }

  async function saveBrief(value: string) {
    if (!state) return;
    const saved = await runMutation("brief", () =>
      updateSettings({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          expectedRevision: state.settingsRevision,
          settings: { ...state.settings, brief: value.trim() },
        },
      }),
    );
    if (saved) setEditingBrief(false);
  }

  async function saveEntry(
    input: Pick<
      MonarchContextEntry,
      | "kind"
      | "title"
      | "body"
      | "scope"
      | "branch"
      | "sourceRefs"
      | "contradictsEntryIds"
      | "evidence"
      | "pinned"
    >,
  ) {
    const item = editingEntry;
    if (!item) return;
    const saved = await runMutation("entry", () =>
      upsertEntry({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          ...(item === "new" ? {} : { id: item.id, expectedRevision: item.revision }),
          ...input,
        },
      }),
    );
    if (saved) setEditingEntry(null);
  }

  async function togglePin(item: MonarchContextEntry) {
    await runMutation(item.id, () =>
      upsertEntry({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          id: item.id,
          expectedRevision: item.revision,
          kind: item.kind,
          title: item.title,
          body: item.body,
          scope: item.scope,
          branch: item.branch,
          sourceRefs: item.sourceRefs,
          contradictsEntryIds: item.contradictsEntryIds,
          evidence: item.evidence,
          pinned: !item.pinned,
        },
      }),
    );
  }

  async function buildContext() {
    const threadIds = validSelected;
    const queued = await runMutation("build", () =>
      refresh({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          mode: "build-context",
          threadIds,
          ...(reanalyze ? { reanalyze: true } : {}),
        },
      }),
    );
    if (queued) {
      setReanalyze(false);
      setNotice("Context build queued. Follow its progress in the project timeline.");
    }
  }

  async function excludeSource(threadId: ThreadId) {
    if (!state || state.settings.excludedThreadIds.includes(threadId)) return;
    await runMutation(`exclude:${threadId}`, () =>
      updateSettings({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          expectedRevision: state.settingsRevision,
          settings: {
            ...state.settings,
            excludedThreadIds: [...state.settings.excludedThreadIds, threadId],
          },
        },
      }),
    );
  }

  const toggleSource = (threadId: ThreadId) => {
    const next = new Set(validSelected);
    if (next.has(threadId)) next.delete(threadId);
    else if (next.size < 20) next.add(threadId);
    setSelectedSourceIds(next);
  };

  return (
    <MonarchPanelShell
      title="Project context"
      description={
        <>
          {projectTitle} · This environment and project only. Reported entries come from agent work;
          confirmed entries are user decisions.
        </>
      }
      presentation={presentation}
      open={open}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        {stateQuery.error ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load context: {stateQuery.error}{" "}
            <Button size="xs" variant="ghost" onClick={stateQuery.refresh}>
              Retry
            </Button>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}{" "}
            <Button size="xs" variant="ghost" onClick={stateQuery.refresh}>
              Reload
            </Button>
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {stateQuery.isPending && !state ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading project context…
          </p>
        ) : null}
        {state ? (
          <div className="space-y-7">
            <section aria-labelledby="project-brief-heading">
              <div className="flex items-center justify-between gap-2">
                <h3 id="project-brief-heading" className="text-sm font-medium">
                  Project brief
                </h3>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canConfigure}
                  onClick={() => {
                    setBriefDraft(state.settings.brief);
                    setEditingBrief(true);
                  }}
                >
                  Edit
                </Button>
              </div>
              {editingBrief ? (
                <form
                  className="mt-2 space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveBrief(briefDraft);
                  }}
                >
                  <label className="block text-xs text-muted-foreground">
                    Your direction and standing context
                    <Textarea
                      value={briefDraft}
                      onChange={(event) => setBriefDraft(event.target.value)}
                      maxLength={8000}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button size="xs" type="submit" disabled={busy === "brief"}>
                      Save brief
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditingBrief(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {state.settings.brief ||
                    "Add a project brief to guide future context and suggestions."}
                </p>
              )}
            </section>
            <section
              aria-labelledby="context-entries-heading"
              className="border-t border-border pt-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="context-entries-heading" className="text-sm font-medium">
                  Current context
                </h3>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canEdit}
                  onClick={() => setEditingEntry("new")}
                >
                  <PlusIcon /> Add entry
                </Button>
              </div>
              {editingEntry ? (
                <ContextEntryEditor
                  key={editingEntry === "new" ? "new" : editingEntry.id}
                  entry={editingEntry === "new" ? null : editingEntry}
                  busy={busy === "entry"}
                  onSave={(input) => void saveEntry(input)}
                  onCancel={() => setEditingEntry(null)}
                />
              ) : null}
              {entries.length === 0 && !editingEntry ? (
                <div className="mt-3 rounded-lg border border-dashed border-border p-4">
                  <p className="text-sm font-medium">No context recorded yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add a brief, write a decision, or build context from completed work in this
                    project.
                  </p>
                </div>
              ) : null}
              {entries.length ? (
                <div className="mt-3 space-y-2">
                  {entries.map((entry) => (
                    <article key={entry.id} className="rounded-lg border border-border p-3.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {KIND_LABEL[entry.kind]}
                        </span>
                        <span>·</span>
                        <span>
                          {entry.evidence === "confirmed"
                            ? "Confirmed by user"
                            : "Reported from work"}
                        </span>
                        <span>·</span>
                        <span>
                          {entry.scope === "branch"
                            ? `Branch work: ${entry.branch ?? "unknown"}`
                            : "Project wide"}
                        </span>
                        {entry.pinned ? (
                          <span className="inline-flex items-center gap-1">
                            <PinIcon size={11} /> Pinned
                          </span>
                        ) : null}
                      </div>
                      <h4 className="mt-2 text-sm font-medium break-words">{entry.title}</h4>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground break-words">
                        {entry.body}
                      </p>
                      {entry.contradictsEntryIds.length ? (
                        <p className="mt-2 text-xs text-warning-foreground">
                          Needs confirmation · Conflicts with {entry.contradictsEntryIds.length}{" "}
                          other context{" "}
                          {entry.contradictsEntryIds.length === 1 ? "entry" : "entries"}.
                        </p>
                      ) : null}
                      {entry.sourceRefs.length ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-2xs">
                          {entry.sourceRefs.map((source) => (
                            <span
                              key={`${source.threadId}:${source.runId ?? ""}`}
                              className="inline-flex items-center gap-1.5"
                            >
                              <Link
                                to="/$environmentId/$threadId"
                                params={buildThreadRouteParams(
                                  scopeThreadRef(projectRef.environmentId, source.threadId),
                                )}
                                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline"
                              >
                                {threadNames.get(source.threadId) || "Source thread"}{" "}
                                <ArrowUpRightIcon size={11} />
                              </Link>
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={
                                  !canConfigure ||
                                  busy === `exclude:${source.threadId}` ||
                                  state.settings.excludedThreadIds.includes(source.threadId)
                                }
                                onClick={() => void excludeSource(source.threadId)}
                              >
                                Exclude source
                              </Button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-2">
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={!canEdit}
                          onClick={() => setEditingEntry(entry)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={!canEdit || busy === entry.id}
                          onClick={() => void togglePin(entry)}
                        >
                          <PinIcon /> {entry.pinned ? "Unpin" : "Pin"}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => {
                            setLatestHistoryEntries(new Map());
                            setHistoryOpen(true);
                            setHistoryBefore(null);
                          }}
                        >
                          <HistoryIcon /> History
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost-destructive"
                          disabled={
                            !canEdit ||
                            busy === entry.id ||
                            (entry.pinned && entry.evidence === "confirmed")
                          }
                          title={
                            entry.pinned && entry.evidence === "confirmed"
                              ? "Unpin this confirmed decision before removing it."
                              : undefined
                          }
                          onClick={() =>
                            void runMutation(entry.id, () =>
                              removeEntry({
                                environmentId: projectRef.environmentId,
                                input: {
                                  projectId: projectRef.projectId,
                                  entryId: entry.id,
                                  expectedRevision: entry.revision,
                                },
                              }),
                            )
                          }
                        >
                          <Trash2Icon /> Remove
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
            <section
              aria-labelledby="context-build-heading"
              className="border-t border-border pt-5"
            >
              <h3 id="context-build-heading" className="text-sm font-medium">
                Build context
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Select up to 20 threads to journal their latest completed turns. Builds reuse saved
                journals.
              </p>
              {sourcesQuery.error ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  Could not load sources: {sourcesQuery.error}{" "}
                  <Button size="xs" variant="ghost" onClick={sourcesQuery.refresh}>
                    Retry
                  </Button>
                </p>
              ) : null}
              {sources.length ? (
                <div className="mt-3 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {sources.map((source) => (
                    <label
                      key={source.threadId}
                      className="flex items-start gap-2 rounded-md px-1 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={validSelected.includes(source.threadId)}
                        disabled={
                          !availableSourceIds.has(source.threadId) ||
                          (!validSelected.includes(source.threadId) && validSelected.length >= 20)
                        }
                        onChange={() => toggleSource(source.threadId)}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium break-words">{source.title}</span>
                        <span className="text-2xs text-muted-foreground">
                          {!availableSourceIds.has(source.threadId)
                            ? "Excluded in suggestion settings"
                            : new Date(source.completedAt).toLocaleString()}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No completed project threads are available yet.
                </p>
              )}
              {validSelected.length > 0 && (
                <label className="my-3 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={reanalyze}
                    disabled={!canBuild || state.settings.paused || busy === "build"}
                    onChange={(event) => setReanalyze(event.target.checked)}
                  />
                  Re-analyze selected turns and save new journal revisions
                </label>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !canBuild ||
                  state.settings.paused ||
                  busy === "build" ||
                  validSelected.length === 0
                }
                onClick={() => void buildContext()}
              >
                <BookOpenIcon /> {busy === "build" ? "Queuing…" : "Build context"}
              </Button>
              {state.settings.paused ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Resume project updates in suggestion settings before building context.
                </p>
              ) : null}
            </section>
            <section
              aria-labelledby="context-history-heading"
              className="border-t border-border pt-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 id="context-history-heading" className="text-sm font-medium">
                  History
                </h3>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => {
                    setLatestHistoryEntries(new Map());
                    setHistoryOpen((value) => !value);
                    setHistoryBefore(null);
                  }}
                >
                  <HistoryIcon /> {historyOpen ? "Hide" : "Show"}
                </Button>
              </div>
              {historyOpen ? (
                <div className="mt-3 space-y-2">
                  {historyQuery.error ? (
                    <p role="alert" className="text-xs text-destructive">
                      Could not load history: {historyQuery.error}{" "}
                      <Button size="xs" variant="ghost" onClick={historyQuery.refresh}>
                        Retry
                      </Button>
                    </p>
                  ) : null}
                  {historyQuery.isPending && !historyQuery.data ? (
                    <p className="text-xs text-muted-foreground">Loading history…</p>
                  ) : null}
                  {historyItems.length === 0 && historyQuery.data ? (
                    <p className="text-xs text-muted-foreground">No changes yet.</p>
                  ) : null}
                  {historyItems.map((item) => {
                    const current =
                      state.entries.find((entry) => entry.id === item.entry.id) ??
                      latestHistoryEntries.get(item.entry.id) ??
                      historyItems.find((row) => row.entry.id === item.entry.id)?.entry;
                    return (
                      <div
                        key={item.sequence}
                        className="rounded-lg border border-border p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                          <span className="font-medium text-foreground">{item.entry.title}</span>
                          <span>
                            · {item.action} · revision {item.entry.revision}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-muted-foreground">{item.entry.body}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            disabled={
                              !canEdit ||
                              busy === `restore:${item.sequence}` ||
                              !current ||
                              (current.pinned &&
                                current.evidence === "confirmed" &&
                                item.entry.evidence !== "confirmed")
                            }
                            onClick={() =>
                              void runMutation(`restore:${item.sequence}`, () =>
                                restoreEntry({
                                  environmentId: projectRef.environmentId,
                                  input: {
                                    projectId: projectRef.projectId,
                                    entryId: item.entry.id,
                                    expectedRevision: current!.revision,
                                    restoreRevision: item.entry.revision,
                                  },
                                }),
                              )
                            }
                          >
                            <RotateCcwIcon /> Restore version
                          </Button>
                          {item.entry.sourceRefs.map((source) => (
                            <Link
                              key={source.threadId}
                              to="/$environmentId/$threadId"
                              params={buildThreadRouteParams(
                                scopeThreadRef(projectRef.environmentId, source.threadId),
                              )}
                              className="text-muted-foreground underline-offset-2 hover:underline"
                            >
                              Source <ArrowUpRightIcon size={11} className="inline" />
                            </Link>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {historyQuery.data?.nextBeforeSequence ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => {
                        rememberHistoryPage();
                        setHistoryBefore(historyQuery.data!.nextBeforeSequence);
                      }}
                    >
                      Older changes
                    </Button>
                  ) : null}
                  {historyBefore !== null ? (
                    <Button size="xs" variant="ghost-muted" onClick={() => setHistoryBefore(null)}>
                      Latest changes
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </div>
    </MonarchPanelShell>
  );
}

function ContextEntryEditor({
  entry,
  busy,
  onSave,
  onCancel,
}: {
  entry: MonarchContextEntry | null;
  busy: boolean;
  onSave: (
    input: Pick<
      MonarchContextEntry,
      | "kind"
      | "title"
      | "body"
      | "scope"
      | "branch"
      | "sourceRefs"
      | "contradictsEntryIds"
      | "evidence"
      | "pinned"
    >,
  ) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<MonarchContextEntry["kind"]>(entry?.kind ?? "decision");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [scope, setScope] = useState<MonarchContextEntry["scope"]>(entry?.scope ?? "project");
  const [branch, setBranch] = useState(entry?.branch ?? "");
  const [evidence, setEvidence] = useState<MonarchContextEntry["evidence"]>(
    entry?.evidence ?? "confirmed",
  );
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    onSave({
      kind,
      title: title.trim(),
      body: body.trim(),
      scope,
      branch: scope === "branch" ? branch.trim() || null : null,
      sourceRefs: entry?.sourceRefs ?? [],
      contradictsEntryIds: entry?.contradictsEntryIds ?? [],
      evidence,
      pinned,
    });
  };
  return (
    <form
      className="mt-3 space-y-3 rounded-lg border border-border bg-muted/25 p-3"
      onSubmit={submit}
    >
      <h4 className="text-sm font-medium">{entry ? "Edit context entry" : "New context entry"}</h4>
      <label className="block space-y-1 text-xs font-medium">
        Category
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as MonarchContextEntry["kind"])}
          className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Title
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Statement
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={4000}
          required
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Scope
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as MonarchContextEntry["scope"])}
          className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="project">Project wide</option>
          <option value="branch">Branch work</option>
        </select>
      </label>
      {scope === "branch" ? (
        <label className="block space-y-1 text-xs font-medium">
          Branch
          <Input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            maxLength={256}
            required
          />
        </label>
      ) : null}
      <label className="block space-y-1 text-xs font-medium">
        Evidence
        <select
          value={evidence}
          onChange={(event) => setEvidence(event.target.value as MonarchContextEntry["evidence"])}
          className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="reported">Reported (unconfirmed)</option>
          <option value="confirmed">Confirmed by you</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
        />{" "}
        Pin this entry
      </label>
      <div className="flex gap-2">
        <Button size="xs" type="submit" disabled={busy || !title.trim() || !body.trim()}>
          Save entry
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
