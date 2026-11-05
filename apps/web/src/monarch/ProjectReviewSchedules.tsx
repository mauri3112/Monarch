import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ModelSelection,
  MonarchReviewSchedule,
  MonarchScheduleRecurrence,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { MONARCH_REVIEW_DRIVER_KINDS } from "@t3tools/contracts";
import { HistoryIcon, PauseIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { monarchEnvironment } from "../state/monarch";
import { requestConfirmDialog } from "../confirmDialog";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REVIEW_DRIVERS = new Set<string>(MONARCH_REVIEW_DRIVER_KINDS);

function recurrenceLabel(recurrence: MonarchScheduleRecurrence, timezone: string) {
  if (recurrence.type === "interval") return `Every ${recurrence.everyMinutes} minutes`;
  if (recurrence.type === "daily") return `Daily at ${recurrence.timeOfDay} · ${timezone}`;
  return `${DAYS[recurrence.weekday]} at ${recurrence.timeOfDay} · ${timezone}`;
}

export function ProjectReviewSchedules({
  projectRef,
  archived,
  editor,
  onEditorChange,
  showEmpty,
}: {
  projectRef: ScopedProjectRef;
  archived: boolean;
  editor: MonarchReviewSchedule | "new" | null;
  onEditorChange: (editor: MonarchReviewSchedule | "new" | null) => void;
  showEmpty: boolean;
}) {
  const query = useEnvironmentQuery(
    monarchEnvironment.schedules.live({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const canEdit =
    useAtomValue(monarchEnvironment.schedules.upsert.permissionAtom(projectRef.environmentId)) &&
    !archived;
  const upsert = useAtomCommand(monarchEnvironment.schedules.upsert, {
    label: "save project review schedule",
  });
  const setEnabled = useAtomCommand(monarchEnvironment.schedules.setEnabled, {
    label: "toggle project review schedule",
  });
  const remove = useAtomCommand(monarchEnvironment.schedules.remove, {
    label: "remove project review schedule",
  });
  const runNow = useAtomCommand(monarchEnvironment.schedules.runNow, {
    label: "run project review",
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schedules = query.data?.schedules ?? [];

  async function save(value: {
    title: string;
    instructions: string;
    recurrence: MonarchScheduleRecurrence;
    timezone: string;
    modelSelection: ModelSelection;
    enabled: boolean;
  }) {
    const item = editor;
    if (!item) return;
    setBusyId("editor");
    setError(null);
    const result = await upsert({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        ...(item === "new" ? {} : { id: item.id, expectedRevision: item.revision }),
        ...value,
      },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    onEditorChange(null);
    query.refresh();
  }

  async function act(item: MonarchReviewSchedule, action: "toggle" | "run" | "remove") {
    if (action === "remove") {
      const confirmed = await requestConfirmDialog(`Delete the scheduled task “${item.title}”?`, {
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    setBusyId(item.id);
    setError(null);
    const base = {
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, id: item.id },
    };
    const result =
      action === "toggle"
        ? await setEnabled({
            ...base,
            input: { ...base.input, expectedRevision: item.revision, enabled: !item.enabled },
          })
        : action === "remove"
          ? await remove({ ...base, input: { ...base.input, expectedRevision: item.revision } })
          : await runNow(base);
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    query.refresh();
  }

  return (
    <>
      {query.error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          Could not load suggestion schedules: {query.error}{" "}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Loading suggestion schedules…
        </p>
      ) : null}
      {editor ? (
        <ReviewEditor
          key={editor === "new" ? "new" : editor.id}
          projectRef={projectRef}
          schedule={editor === "new" ? null : editor}
          busy={busyId === "editor"}
          onSave={(value) => void save(value)}
          onCancel={() => onEditorChange(null)}
        />
      ) : null}
      {showEmpty && query.data && schedules.length === 0 && !editor ? (
        <div className="mt-4 rounded-xl border border-dashed border-border p-4">
          <p className="text-sm font-medium">No scheduled tasks yet</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Run a prompt or suggest next threads on a schedule.
          </p>
        </div>
      ) : null}
      {schedules.length ? (
        <div className="mt-4 space-y-2">
          {schedules.map((schedule) => (
            <ReviewCard
              key={schedule.id}
              projectRef={projectRef}
              schedule={schedule}
              canEdit={canEdit}
              busy={busyId === schedule.id}
              onEdit={() => onEditorChange(schedule)}
              onAct={(action) => void act(schedule, action)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ReviewCard({
  projectRef,
  schedule,
  canEdit,
  busy,
  onEdit,
  onAct,
}: {
  projectRef: ScopedProjectRef;
  schedule: MonarchReviewSchedule;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onAct: (action: "toggle" | "run" | "remove") => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useEnvironmentQuery(
    historyOpen
      ? monarchEnvironment.schedules.history({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId, id: schedule.id },
        })
      : null,
  );
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium break-words">{schedule.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Suggests next threads · {recurrenceLabel(schedule.recurrence, schedule.timezone)}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-3xs text-muted-foreground">
          {schedule.enabled ? "Active" : "Paused"}
        </span>
      </div>
      {schedule.instructions ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {schedule.instructions}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-3 text-2xs text-muted-foreground">
        <span>
          {schedule.modelSelection.instanceId} · {schedule.modelSelection.model}
        </span>
        <span>
          {schedule.enabled && schedule.nextRunAt
            ? `Next ${new Date(schedule.nextRunAt).toLocaleString()}`
            : "No next run"}
        </span>
        {schedule.lastRunAt ? (
          <span>
            Last {schedule.lastRunStatus} · {new Date(schedule.lastRunAt).toLocaleString()}
          </span>
        ) : null}
        {schedule.lastRunError ? (
          <span className="text-destructive">{schedule.lastRunError}</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="xs" variant="ghost-muted" disabled={!canEdit || busy} onClick={onEdit}>
          <PencilIcon /> Edit
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canEdit || busy}
          onClick={() => onAct("toggle")}
        >
          {schedule.enabled ? <PauseIcon /> : <PlayIcon />}
          {schedule.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canEdit || busy}
          onClick={() => onAct("run")}
        >
          <PlayIcon /> Run now
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => setHistoryOpen((value) => !value)}>
          <HistoryIcon /> History
        </Button>
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={!canEdit || busy}
          onClick={() => onAct("remove")}
        >
          <Trash2Icon /> Delete
        </Button>
      </div>
      {historyOpen ? (
        <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          {history.error ? <p role="alert">Could not load history: {history.error}</p> : null}
          {history.isPending && !history.data ? <p>Loading history…</p> : null}
          {history.data?.runs.length === 0 ? <p>No runs yet.</p> : null}
          {history.data?.runs.map((run) => (
            <div key={run.id} className="flex flex-wrap justify-between gap-2 py-1">
              <span>
                {new Date(run.startedAt).toLocaleString()} · {run.trigger}
              </span>
              <span>
                {run.status}
                {run.suggestionIds.length ? ` · ${run.suggestionIds.length} suggestions` : ""}
              </span>
              {run.error ? <span className="w-full text-destructive">{run.error}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ReviewEditor({
  projectRef,
  schedule,
  busy,
  onSave,
  onCancel,
}: {
  projectRef: ScopedProjectRef;
  schedule: MonarchReviewSchedule | null;
  busy: boolean;
  onSave: (value: {
    title: string;
    instructions: string;
    recurrence: MonarchScheduleRecurrence;
    timezone: string;
    modelSelection: ModelSelection;
    enabled: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const project = useProject(projectRef);
  const settings = useEnvironmentSettings(projectRef.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(projectRef.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, projectRef.projectId).filter(
    (entry) =>
      REVIEW_DRIVERS.has(entry.driverKind) &&
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const [title, setTitle] = useState(schedule?.title ?? "Suggest next threads");
  const [instructions, setInstructions] = useState(
    schedule?.instructions ??
      "Review recent project threads against active Targets and propose useful next threads with evidence.",
  );
  const [mode, setMode] = useState<MonarchScheduleRecurrence["type"]>(
    schedule?.recurrence.type ?? "daily",
  );
  const [everyMinutes, setEveryMinutes] = useState(
    schedule?.recurrence.type === "interval" ? String(schedule.recurrence.everyMinutes) : "1440",
  );
  const [timeOfDay, setTimeOfDay] = useState(
    schedule?.recurrence.type !== "interval"
      ? (schedule?.recurrence.timeOfDay ?? "09:00")
      : "09:00",
  );
  const [weekday, setWeekday] = useState(
    schedule?.recurrence.type === "weekly" ? schedule.recurrence.weekday : 1,
  );
  const [timezone, setTimezone] = useState(
    schedule?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [selection, setSelection] = useState<ModelSelection | null>(
    schedule?.modelSelection ?? null,
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const selected = selection ?? scheduledTaskDefaultModel(settings, project ?? null, entries);
  const selectedEntry = entries.find((entry) => entry.instanceId === selected?.instanceId);
  const selectedAvailable =
    selectedEntry?.models.some(
      (model) => model.slug === selected?.model || model.aliases?.includes(selected?.model ?? ""),
    ) ?? false;
  const activeInstanceId = selectedEntry?.instanceId ?? entries[0]?.instanceId;
  const modelOptions = activeInstanceId
    ? getCustomModelOptionsByInstance(
        settings,
        providers,
        activeInstanceId,
        selectedEntry ? (selected?.model ?? "") : "",
      )
    : new Map();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !selectedAvailable || !title.trim()) return;
    const recurrence: MonarchScheduleRecurrence =
      mode === "interval"
        ? { type: "interval", everyMinutes: Number(everyMinutes) }
        : mode === "daily"
          ? { type: "daily", timeOfDay }
          : { type: "weekly", timeOfDay, weekday };
    onSave({
      title: title.trim(),
      instructions: instructions.trim(),
      recurrence,
      timezone: timezone.trim(),
      modelSelection: selected,
      enabled,
    });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-3 rounded-xl border border-border bg-muted/25 p-4"
    >
      <h3 className="text-sm font-medium">
        {schedule ? "Edit suggestion schedule" : "Suggest next threads"}
      </h3>
      <p className="text-xs text-muted-foreground">
        Find ideas from active Targets and recent threads. You choose which suggestions to use.
      </p>
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
        Instructions
        <Textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={4000}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium">
        Frequency
        <select
          className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={mode}
          onChange={(event) => setMode(event.target.value as MonarchScheduleRecurrence["type"])}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="interval">Every few minutes</option>
        </select>
      </label>
      {mode === "interval" ? (
        <label className="block space-y-1 text-xs font-medium">
          Minutes between runs
          <Input
            type="number"
            min={15}
            max={43200}
            value={everyMinutes}
            onChange={(event) => setEveryMinutes(event.target.value)}
            required
          />
        </label>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {mode === "weekly" ? (
            <label className="block space-y-1 text-xs font-medium">
              Day
              <select
                className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={weekday}
                onChange={(event) => setWeekday(Number(event.target.value))}
              >
                {DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1 text-xs font-medium">
            Time
            <Input
              type="time"
              value={timeOfDay}
              onChange={(event) => setTimeOfDay(event.target.value)}
              required
            />
          </label>
        </div>
      )}
      <label className="block space-y-1 text-xs font-medium">
        Timezone
        <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
      </label>
      <div className="space-y-1 text-xs font-medium">
        <span>Model</span>
        {activeInstanceId ? (
          <ProviderModelPicker
            environmentId={projectRef.environmentId}
            activeInstanceId={activeInstanceId}
            model={selectedEntry ? (selected?.model ?? "") : ""}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            isComposerOwned={false}
            disabled={busy}
            onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
          />
        ) : (
          <p className="text-muted-foreground">
            Connect an available Codex or Claude provider to schedule suggestions.
          </p>
        )}
        {selected && !selectedAvailable ? (
          <p className="text-muted-foreground">Choose an available Codex or Claude model.</p>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Start schedule after saving
      </label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || !selectedAvailable || !title.trim()}>
          Save task
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
