import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MonarchReviewSchedule, ScheduledTask, ScopedProjectRef } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PauseIcon, PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { scheduleLabel } from "../components/settings/scheduledTaskLabels";
import { Button } from "../components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../components/ui/menu";
import { readEnvironmentScope } from "../state/session";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ProjectReviewSchedules } from "./ProjectReviewSchedules";

export function ProjectSchedules({
  projectRef,
  archived,
}: {
  projectRef: ScopedProjectRef;
  archived: boolean;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({
      environmentId: projectRef.environmentId,
      input: {},
    }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(projectRef.environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "project scheduled task toggle",
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "project scheduled task run",
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestionEditor, setSuggestionEditor] = useState<MonarchReviewSchedule | "new" | null>(
    null,
  );
  const tasks = (query.data?.tasks ?? []).filter((task) => task.projectId === projectRef.projectId);

  const edit = (task?: ScheduledTask) =>
    void navigate({
      to: "/settings/scheduled-tasks",
      search: {
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
        ...(task ? { taskId: task.id } : { newTask: true }),
      },
    });
  const act = async (task: ScheduledTask, action: "toggle" | "run") => {
    if (busyId || !readEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope))
      return;
    setBusyId(task.id);
    setError(null);
    const result =
      action === "toggle"
        ? await setEnabled({
            environmentId: projectRef.environmentId,
            input: { id: task.id, enabled: !task.enabled },
          })
        : await runNow({ environmentId: projectRef.environmentId, input: { id: task.id } });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <section aria-labelledby="monarch-schedules-heading" className="border-t border-border pt-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="monarch-schedules-heading" className="text-base font-medium tracking-tight">
          Scheduled tasks
        </h2>
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" disabled={archived || !canOperate} />}
          >
            <PlusIcon /> Add task
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => edit()}>Run a prompt</MenuItem>
            <MenuItem onClick={() => setSuggestionEditor("new")}>Suggest next threads</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {query.error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          Could not load tasks: {query.error}{" "}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p role="status" className="mt-4 text-xs text-muted-foreground">
          Loading scheduled tasks…
        </p>
      ) : null}
      <ProjectReviewSchedules
        projectRef={projectRef}
        archived={archived}
        editor={suggestionEditor}
        onEditorChange={setSuggestionEditor}
        showEmpty={query.data !== undefined && tasks.length === 0}
      />
      {tasks.length > 0 ? (
        <div className="mt-4 space-y-2">
          {tasks.map((task) => (
            <article key={task.id} className="rounded-xl border border-border bg-card px-4 py-3.5">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium break-words">{task.title}</h3>
                    <span className="rounded-full border border-border px-2 py-0.5 text-3xs text-muted-foreground">
                      {task.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {task.prompt}
                  </p>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${task.title}`}
                  onClick={() => edit(task)}
                >
                  <PencilIcon />
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 pt-3 text-2xs text-muted-foreground">
                <span>Runs a prompt</span>
                <span>{scheduleLabel(task.schedule)}</span>
                <span>
                  {task.blockedByPolicy ??
                    (!task.enabled
                      ? "Paused"
                      : task.nextRunAt
                        ? `Next ${new Date(task.nextRunAt).toLocaleString()}`
                        : "No next run")}
                </span>
                {task.lastRunAt ? (
                  <span>
                    Last {task.lastRunStatus} · {new Date(task.lastRunAt).toLocaleString()}
                  </span>
                ) : null}
                {task.lastRunError ? (
                  <span className="text-destructive">{task.lastRunError}</span>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busyId === task.id || !canOperate || archived}
                  onClick={() => void act(task, "toggle")}
                >
                  {task.enabled ? <PauseIcon /> : <PlayIcon />}
                  {task.enabled ? "Pause" : "Resume"}
                </Button>
                {task.schedule.type !== "webhook" ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={busyId === task.id || !canOperate || archived}
                    onClick={() => void act(task, "run")}
                  >
                    <PlayIcon /> Run now
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
