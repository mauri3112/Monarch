import { useAtomValue } from "@effect/atom-react";
import {
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MONARCH_REVIEW_DRIVER_KINDS,
  type MonarchContextSettings,
  type MonarchReviewSchedule,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION } from "@t3tools/shared/monarchContext";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { MonarchPanelShell } from "./MonarchPanelShell";
import { ProjectReviewSchedules } from "./ProjectReviewSchedules";

const REVIEW_DRIVERS = new Set<string>(MONARCH_REVIEW_DRIVER_KINDS);
const REASON_LABEL = {
  paused: "Paused",
  "active-work": "Waiting for active work",
  "daily-limit": "Daily limit reached",
  failed: "Last update failed",
} as const;
const TRIGGER_LABEL = {
  scheduled: "Scheduled refresh",
  manual: "Manual update",
  "work-completed": "Completed work",
  "targets-changed": "Target changed",
  "project-changed": "Project changed",
  "build-context": "Built context",
  refresh: "Manual refresh",
  retry: "Retry",
} as const;

export function SuggestionSettingsPanel({
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
  const activityQuery = useEnvironmentQuery(
    monarchEnvironment.continuity.activity({
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
  const canEdit =
    useAtomValue(
      monarchEnvironment.context.updateSettings.permissionAtom(projectRef.environmentId),
    ) && !archived;
  const canRefresh =
    useAtomValue(monarchEnvironment.continuity.refresh.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const canSchedule =
    useAtomValue(monarchEnvironment.schedules.upsert.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const updateSettings = useAtomCommand(monarchEnvironment.context.updateSettings, {
    label: "save suggestion settings",
  });
  const refresh = useAtomCommand(monarchEnvironment.continuity.refresh, {
    label: "refresh project suggestions",
  });
  const [busy, setBusy] = useState<"save" | "refresh" | "retry" | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<MonarchReviewSchedule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = stateQuery.data;
  const activity = activityQuery.data;
  const latestCompletedRunId = activity?.runs.find((run) => run.completedAt)?.id ?? null;
  const seenCompletedRunId = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the remote source list after a new project update finishes while this panel stays open
  useEffect(() => {
    if (!open || latestCompletedRunId === null) return;
    if (
      seenCompletedRunId.current !== null &&
      seenCompletedRunId.current !== latestCompletedRunId
    ) {
      refreshSources();
    }
    seenCompletedRunId.current = latestCompletedRunId;
  }, [open, latestCompletedRunId, refreshSources]);
  const lastFailed =
    activity?.blockedReason === "failed" ||
    activity?.runs[0]?.status === "failed" ||
    activity?.runs[0]?.status === "interrupted";

  async function save(settings: MonarchContextSettings) {
    if (!state) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    const result = await updateSettings({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        expectedRevision: state.settingsRevision,
        settings,
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setNotice("Suggestion settings saved.");
    stateQuery.refresh();
  }

  async function run(mode: "refresh" | "retry") {
    setBusy(mode);
    setError(null);
    setNotice(null);
    const result = await refresh({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, mode },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setNotice(mode === "retry" ? "Retry queued." : "Project refresh queued.");
    activityQuery.refresh();
  }

  return (
    <MonarchPanelShell
      title="Suggestion settings"
      description={
        <>
          {projectTitle} · Only this environment and project. Background updates maintain context
          and suggest next threads; they do not start work.
        </>
      }
      presentation={presentation}
      open={open}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        {stateQuery.error ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load settings: {stateQuery.error}{" "}
            <Button size="xs" variant="ghost" onClick={stateQuery.refresh}>
              Retry
            </Button>
          </p>
        ) : null}
        {activityQuery.error ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load activity: {activityQuery.error}{" "}
            <Button size="xs" variant="ghost" onClick={activityQuery.refresh}>
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
            Loading suggestion settings…
          </p>
        ) : null}
        {state ? (
          <div className="space-y-7">
            <SettingsForm
              key={`${projectRef.environmentId}:${projectRef.projectId}:${state.settingsRevision}`}
              projectRef={projectRef}
              settings={state.settings}
              sources={sourcesQuery.data?.sources ?? []}
              canEdit={canEdit}
              busy={busy === "save"}
              onSave={(settings) => void save(settings)}
            />
            <section
              aria-labelledby="scheduled-refresh-heading"
              className="border-t border-border pt-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="scheduled-refresh-heading" className="text-sm font-medium">
                    Scheduled refresh
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Timed suggestion updates are also shown under Scheduled tasks.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canSchedule}
                  onClick={() => setScheduleEditor("new")}
                >
                  <PlusIcon /> Add schedule
                </Button>
              </div>
              <ProjectReviewSchedules
                projectRef={projectRef}
                archived={archived}
                editor={scheduleEditor}
                onEditorChange={setScheduleEditor}
                showEmpty={false}
              />
            </section>
            <section
              aria-labelledby="suggestion-activity-heading"
              className="border-t border-border pt-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="suggestion-activity-heading" className="text-sm font-medium">
                    Activity
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {activity
                      ? state.settings.modelSelection
                        ? `${activity.updatesToday} of ${activity.maxUpdatesPerDay} updates today. Each update may make up to two model requests.`
                        : `${activity.updatesToday} updates today. Choose a suggestion model to run a review.`
                      : "Loading activity…"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      !canRefresh ||
                      !state.settings.modelSelection ||
                      state.settings.paused ||
                      busy !== null ||
                      activity?.blockedReason === "daily-limit"
                    }
                    onClick={() => void run("refresh")}
                  >
                    <RotateCcwIcon /> Refresh now
                  </Button>
                  {lastFailed ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={
                        !canRefresh ||
                        !state.settings.modelSelection ||
                        state.settings.paused ||
                        busy !== null ||
                        activity?.blockedReason === "daily-limit"
                      }
                      onClick={() => void run("retry")}
                    >
                      Retry failed
                    </Button>
                  ) : null}
                </div>
              </div>
              {!state.settings.modelSelection ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Choose and save a suggestion model before refreshing this project.
                </p>
              ) : null}
              {activity?.pending ? (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  An update is queued. It will run when the project is available.
                </p>
              ) : null}
              {activity?.blockedReason ? (
                <p role="status" className="mt-2 text-xs text-warning-foreground">
                  {REASON_LABEL[activity.blockedReason]}
                  {activity.blockedReason === "paused"
                    ? " · Resume in settings and save to continue."
                    : null}
                </p>
              ) : null}
              {activity?.runs.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No project updates yet.</p>
              ) : null}
              {activity?.runs.length ? (
                <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
                  {activity.runs.map((run) => (
                    <div key={run.id} className="rounded-lg border border-border p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{TRIGGER_LABEL[run.trigger]}</span>
                        <span className="text-muted-foreground">
                          {new Date(run.startedAt).toLocaleString()} · {run.status}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {run.contextRevision !== undefined
                          ? `Context revision ${run.contextRevision} · `
                          : ""}
                        {run.contextEntryIds?.length
                          ? `${run.contextEntryIds.length} context entries · `
                          : ""}
                        {run.suggestionIds.length
                          ? `${run.suggestionIds.length} suggestions`
                          : "No new suggestions"}
                      </p>
                      {run.summary ? (
                        <p className="mt-1 text-muted-foreground">{run.summary}</p>
                      ) : null}
                      {run.error ? <p className="mt-1 text-destructive">{run.error}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </div>
    </MonarchPanelShell>
  );
}

function SettingsForm({
  projectRef,
  settings,
  sources,
  canEdit,
  busy,
  onSave,
}: {
  projectRef: ScopedProjectRef;
  settings: MonarchContextSettings;
  sources: ReadonlyArray<{ threadId: ThreadId; title: string; excluded: boolean }>;
  canEdit: boolean;
  busy: boolean;
  onSave: (settings: MonarchContextSettings) => void;
}) {
  const providerSettings = useEnvironmentSettings(projectRef.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(projectRef.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(
    providers,
    providerSettings,
    projectRef.projectId,
  ).filter(
    (entry) =>
      REVIEW_DRIVERS.has(entry.driverKind) &&
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const [draft, setDraft] = useState(settings);
  const selected = draft.modelSelection;
  const selectedEntry = entries.find((entry) => entry.instanceId === selected?.instanceId);
  const selectedAvailable =
    selectedEntry?.models.some(
      (model) => model.slug === selected?.model || model.aliases?.includes(selected?.model ?? ""),
    ) ?? false;
  const activeInstanceId = selectedEntry?.instanceId ?? entries[0]?.instanceId;
  const modelOptions = activeInstanceId
    ? getCustomModelOptionsByInstance(
        providerSettings,
        providers,
        activeInstanceId,
        selectedEntry ? (selected?.model ?? "") : "",
      )
    : new Map();
  const journal = draft.journalModelSelection ?? DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION;
  const journalEntry = entries.find((entry) => entry.instanceId === journal.instanceId);
  const journalModel = journalEntry?.models.find(
    (model) => model.slug === journal.model || model.aliases?.includes(journal.model),
  );
  const journalPickerInstance = journalEntry?.instanceId ?? entries[0]?.instanceId;
  const journalOptions = getCustomModelOptionsByInstance(
    providerSettings,
    providers,
    journal.instanceId,
    journal.model,
  );
  const reasoning = journalModel?.capabilities?.optionDescriptors?.find(isReasoningSelect);
  const effortId =
    reasoning?.id ?? (journalEntry?.driverKind === "claudeAgent" ? "effort" : "reasoningEffort");
  const effort = getModelSelectionStringOptionValue(journal, effortId);
  const effortChoices = reasoning ? selectableProviderOptionChoices(reasoning) : [];
  const supportedEffort = !effort || effortChoices.some((choice) => choice.id === effort);
  const journalAvailable = !!journalModel && supportedEffort;
  const needsJournal =
    (draft.enabled && draft.autoUpdateContext) ||
    draft.journalModelSelection !== settings.journalModelSelection;
  const valid =
    (!draft.enabled || !!selected) &&
    (draft.paused ||
      (((!draft.enabled && !selected) || selectedAvailable) &&
        (!needsJournal || journalAvailable)));
  const update = (patch: Partial<MonarchContextSettings>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSave(draft);
  };
  const excluded = new Set(draft.excludedThreadIds);
  const otherExcluded = draft.excludedThreadIds.filter(
    (id) => !sources.some((source) => source.threadId === id),
  );
  const toggleExcluded = (id: ThreadId) =>
    update({
      excludedThreadIds: excluded.has(id)
        ? draft.excludedThreadIds.filter((item) => item !== id)
        : [...draft.excludedThreadIds, id],
    });

  return (
    <form onSubmit={save} className="space-y-6">
      <section aria-labelledby="automatic-updates-heading">
        <h3 id="automatic-updates-heading" className="text-sm font-medium">
          Automatic updates
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Opt in to project updates after relevant work or Target changes. No work thread is started
          automatically.
        </p>
        <div className="mt-4 space-y-3">
          <SettingToggle
            label="Enable automatic updates"
            checked={draft.enabled}
            disabled={!canEdit}
            onChange={(value) => update({ enabled: value })}
          />
          <SettingToggle
            label="Journal completed work"
            checked={draft.autoUpdateContext}
            disabled={!canEdit || !draft.enabled}
            onChange={(value) => update({ autoUpdateContext: value })}
          />
          <SettingToggle
            label="Refresh suggestions after work"
            checked={draft.suggestAfterWork}
            disabled={!canEdit || !draft.enabled}
            onChange={(value) => update({ suggestAfterWork: value })}
          />
          <SettingToggle
            label="Refresh suggestions when Targets change"
            checked={draft.suggestAfterTargetChange}
            disabled={!canEdit || !draft.enabled}
            onChange={(value) => update({ suggestAfterTargetChange: value })}
          />
          <SettingToggle
            label="Pause project updates"
            checked={draft.paused}
            disabled={!canEdit}
            onChange={(value) => update({ paused: value })}
          />
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          Pause applies to automatic, scheduled, and manual project updates. Save to apply changes.
        </p>
      </section>
      <section aria-labelledby="suggestion-usage-heading" className="border-t border-border pt-5">
        <h3 id="suggestion-usage-heading" className="text-sm font-medium">
          Model and limits
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Scheduled tasks use their own model. These limits apply to all project updates. Daily
          usage resets at 00:00 UTC.
        </p>
        <div className="mt-3 space-y-3">
          <div className="space-y-1 text-xs font-medium">
            <span>Suggestion model</span>
            {activeInstanceId ? (
              <ProviderModelPicker
                environmentId={projectRef.environmentId}
                activeInstanceId={activeInstanceId}
                model={selectedEntry ? (selected?.model ?? "") : ""}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                isComposerOwned={false}
                {...(!selected ? { triggerLabel: "Choose model" } : {})}
                triggerAriaLabel="Choose suggestion model"
                disabled={!canEdit || busy}
                onInstanceModelChange={(instanceId, model) =>
                  update({
                    modelSelection:
                      selected?.instanceId === instanceId && selected.model === model
                        ? selected
                        : { instanceId, model },
                  })
                }
              />
            ) : (
              <p className="font-normal text-muted-foreground">
                Connect an available Codex or Claude provider.
              </p>
            )}
            {!selected ? (
              <p className="font-normal text-muted-foreground">
                Choose a model to review project context and suggest next threads.
              </p>
            ) : null}
            {selected && !selectedAvailable ? (
              <p className="font-normal text-warning-foreground">
                Choose an available Codex or Claude model before enabling updates.
              </p>
            ) : null}
            {draft.modelSelection ? (
              <Button
                size="xs"
                type="button"
                variant="ghost-muted"
                disabled={!canEdit || busy}
                onClick={() => update({ modelSelection: null })}
              >
                Clear model
              </Button>
            ) : null}
          </div>
          <div className="space-y-1 text-xs">
            <span className="font-medium">Thread journal model</span>
            <div className="flex flex-wrap items-center gap-2">
              {journalPickerInstance ? (
                <ProviderModelPicker
                  environmentId={projectRef.environmentId}
                  activeInstanceId={journalPickerInstance}
                  model={journalEntry ? journal.model : ""}
                  triggerLabel={journalModel?.name ?? journal.model}
                  triggerAriaLabel="Choose thread journal model"
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={journalOptions}
                  isComposerOwned={false}
                  disabled={!canEdit || busy}
                  onInstanceModelChange={(instanceId, model) => {
                    if (journal.instanceId === instanceId && journal.model === model) return;
                    update({
                      journalModelSelection:
                        instanceId === DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION.instanceId &&
                        model === DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION.model
                          ? DEFAULT_MONARCH_JOURNAL_MODEL_SELECTION
                          : { instanceId, model },
                    });
                  }}
                />
              ) : (
                <span>{journal.model}</span>
              )}
              {(effortChoices.length > 0 || effort) && (
                <label className="flex items-center gap-1.5">
                  Effort
                  <select
                    aria-label="Thread journal reasoning effort"
                    className="rounded-md border border-border bg-background px-1.5 py-1"
                    disabled={!canEdit || busy || !journalModel}
                    value={effort ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      const others =
                        journal.options?.filter((option) => option.id !== effortId) ?? [];
                      update({
                        journalModelSelection: {
                          ...journal,
                          options: value ? [...others, { id: effortId, value }] : others,
                        },
                      });
                    }}
                  >
                    <option value="">Automatic</option>
                    {!supportedEffort && <option value={effort}>{effort} (unavailable)</option>}
                    {effortChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-muted-foreground">
              Saves a short account of each eligible turn for future suggestions. Changes apply to
              future journals.
            </p>
            {!journalAvailable && (
              <p className="text-warning-foreground">
                {journalModel
                  ? "Choose an available reasoning effort."
                  : "Connect the journal provider or choose an available model."}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-xs font-medium">
              Updates per day
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.maxUpdatesPerDay}
                onChange={(event) => update({ maxUpdatesPerDay: Number(event.target.value) })}
                disabled={!canEdit}
                required
              />
            </label>
            <label className="block space-y-1 text-xs font-medium">
              Open suggestions limit
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.maxOpenSuggestions}
                onChange={(event) => update({ maxOpenSuggestions: Number(event.target.value) })}
                disabled={!canEdit}
                required
              />
            </label>
          </div>
        </div>
      </section>
      <section aria-labelledby="suggestion-sources-heading" className="border-t border-border pt-5">
        <h3 id="suggestion-sources-heading" className="text-sm font-medium">
          Sources and instructions
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Only this project’s threads are considered. Excluded threads stay out of automatic capture
          and reviews.
        </p>
        {sources.length ? (
          <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {sources.map((source) => (
              <label key={source.threadId} className="flex items-center gap-2 px-1 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={excluded.has(source.threadId)}
                  disabled={!canEdit}
                  onChange={() => toggleExcluded(source.threadId)}
                />
                <span className="min-w-0 truncate">Exclude {source.title}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No completed source threads yet.</p>
        )}
        {otherExcluded.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {otherExcluded.map((id) => (
              <Button
                key={id}
                size="xs"
                variant="ghost-muted"
                disabled={!canEdit}
                onClick={() => toggleExcluded(id)}
              >
                Remove exclusion {id}
              </Button>
            ))}
          </div>
        ) : null}
        <label className="mt-3 block space-y-1 text-xs font-medium">
          Additional instructions
          <Textarea
            value={draft.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            maxLength={4000}
            disabled={!canEdit}
            placeholder="How should project updates weigh evidence or prioritize next steps?"
          />
        </label>
      </section>
      <Button size="sm" type="submit" disabled={!canEdit || busy || !valid}>
        Save settings
      </Button>
    </form>
  );
}

function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs leading-relaxed">{label}</span>
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={onChange}
      />
    </div>
  );
}
