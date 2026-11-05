import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const MONARCH_REVIEW_DRIVER_KINDS = ["codex", "claude", "claudeAgent"] as const;

const BoundedText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const MonarchScheduleId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
export const MonarchScheduleTimezone = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.makeFilter((value) => {
    try {
      return (
        new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone.length > 0
      );
    } catch {
      return "Expected an IANA timezone, such as Europe/Berlin.";
    }
  }),
);
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export const MonarchScheduleRecurrence = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMinutes: Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 43_200 })),
  }),
  Schema.Struct({ type: Schema.Literal("daily"), timeOfDay: TimeOfDay }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    timeOfDay: TimeOfDay,
    weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  }),
]);
export type MonarchScheduleRecurrence = typeof MonarchScheduleRecurrence.Type;

export const MonarchScheduleRunStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const ScheduleFields = {
  projectId: ProjectId,
  title: BoundedText,
  instructions: Schema.String.check(Schema.isMaxLength(4000)),
  recurrence: MonarchScheduleRecurrence,
  timezone: MonarchScheduleTimezone,
  modelSelection: ModelSelection,
  enabled: Schema.Boolean,
};
export const MonarchReviewSchedule = Schema.Struct({
  ...ScheduleFields,
  id: MonarchScheduleId,
  kind: Schema.Literal("review-project"),
  revision: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: Schema.Literals(["idle", "running", "succeeded", "failed", "interrupted"]),
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int,
});
export type MonarchReviewSchedule = typeof MonarchReviewSchedule.Type;
export const MonarchScheduleRun = Schema.Struct({
  id: Schema.String,
  scheduleId: MonarchScheduleId,
  projectId: ProjectId,
  trigger: Schema.Literals([
    "scheduled",
    "manual",
    "work-completed",
    "targets-changed",
    "project-changed",
    "build-context",
    "refresh",
    "retry",
  ]),
  scheduledFor: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  status: MonarchScheduleRunStatus,
  error: Schema.NullOr(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  modelSelection: ModelSelection,
  suggestionIds: Schema.Array(Schema.String),
  contextRevision: Schema.optionalKey(Schema.Int),
  contextEntryIds: Schema.optionalKey(Schema.Array(Schema.String)),
  sourceRunIds: Schema.optionalKey(Schema.Array(RunId)),
  requestVersion: Schema.optionalKey(Schema.Int),
  updateContext: Schema.optionalKey(Schema.Boolean),
  updateSuggestions: Schema.optionalKey(Schema.Boolean),
});
export type MonarchScheduleRun = typeof MonarchScheduleRun.Type;
export const MonarchSchedulesListInput = Schema.Struct({ projectId: ProjectId });
export const MonarchSchedulesListResult = Schema.Struct({
  schedules: Schema.Array(MonarchReviewSchedule),
});
export const MonarchSchedulesUpsertInput = Schema.Struct({
  ...ScheduleFields,
  id: Schema.optional(MonarchScheduleId),
  expectedRevision: Schema.optional(Schema.Int),
});
export type MonarchSchedulesUpsertInput = typeof MonarchSchedulesUpsertInput.Type;
export const MonarchScheduleIdentity = Schema.Struct({
  projectId: ProjectId,
  id: MonarchScheduleId,
});
export type MonarchScheduleIdentity = typeof MonarchScheduleIdentity.Type;
export const MonarchSchedulesSetEnabledInput = Schema.Struct({
  ...MonarchScheduleIdentity.fields,
  enabled: Schema.Boolean,
  expectedRevision: Schema.Int,
});
export const MonarchSchedulesRemoveInput = Schema.Struct({
  ...MonarchScheduleIdentity.fields,
  expectedRevision: Schema.Int,
});
export class MonarchScheduleError extends Schema.TaggedError<MonarchScheduleError>()(
  "MonarchScheduleError",
  {
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "busy",
      "provider_unavailable",
      "generation_failed",
      "persistence",
      "paused",
      "daily_limit",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid":
        return "The project review schedule is invalid.";
      case "not_found":
        return "The project or review schedule is unavailable.";
      case "conflict":
        return "The review schedule changed. Reload it before saving.";
      case "busy":
        return "A project review is already running. Try again after it finishes.";
      case "provider_unavailable":
        return "The selected provider or model is unavailable for project reviews.";
      case "generation_failed":
        return "The project review failed to produce valid suggestions.";
      case "persistence":
        return "The project review could not be saved or loaded.";
      case "paused":
        return "Project updates are paused. Resume them in suggestion settings.";
      case "daily_limit":
        return "This project's daily review limit has been reached.";
    }
  }
}
export const MonarchSchedulesRunNowResult = Schema.Struct({ runId: Schema.String });
export const MonarchSchedulesHistoryResult = Schema.Struct({
  runs: Schema.Array(MonarchScheduleRun),
});
export const MonarchProjectRefreshInput = Schema.Struct({
  projectId: ProjectId,
  mode: Schema.Literals(["build-context", "refresh", "retry"]),
  threadIds: Schema.optionalKey(
    Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ),
});
export type MonarchProjectRefreshInput = typeof MonarchProjectRefreshInput.Type;
export const MonarchProjectRefreshResult = Schema.Struct({
  jobId: Schema.String,
  status: Schema.Literal("queued"),
});
export const MonarchProjectActivityResult = Schema.Struct({
  pending: Schema.Boolean,
  blockedReason: Schema.NullOr(Schema.Literals(["paused", "active-work", "daily-limit", "failed"])),
  updatesToday: Schema.Int,
  maxUpdatesPerDay: Schema.Int,
  runs: Schema.Array(MonarchScheduleRun),
});
export type MonarchProjectActivityResult = typeof MonarchProjectActivityResult.Type;
export const MonarchProjectSourcesResult = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      runId: RunId,
      completedAt: IsoDateTime,
      excluded: Schema.Boolean,
    }),
  ),
});
export type MonarchProjectSourcesResult = typeof MonarchProjectSourcesResult.Type;
