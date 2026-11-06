import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const EntityKind = Schema.Literals([
  "target",
  "thread",
  "suggestion",
  "prompt-schedule",
  "review-schedule",
  "review",
  "journal",
]);
export const MonarchTimelineFocus = Schema.Struct({
  entityKind: EntityKind,
  entityId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type MonarchTimelineFocus = typeof MonarchTimelineFocus.Type;
export const MonarchTimelineInput = Schema.Struct({
  projectId: ProjectId,
  focus: Schema.optionalKey(
    Schema.Struct({
      ...MonarchTimelineFocus.fields,
      eventId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(600))),
    }),
  ),
});
export type MonarchTimelineInput = typeof MonarchTimelineInput.Type;
export const MonarchTimelineEvent = Schema.Struct({
  id: Schema.String,
  family: Schema.Literals(["target", "thread", "suggestion", "schedule", "model"]),
  ...MonarchTimelineFocus.fields,
  action: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  at: Schema.NullOr(IsoDateTime),
  state: Schema.Literals([
    "active",
    "draft",
    "recorded",
    "running",
    "needs-input",
    "upcoming",
    "conditional",
    "failed",
    "interrupted",
    "ready",
    "finished",
    "archived",
    "achieved",
    "paused",
  ]),
  parentIds: Schema.Array(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(Schema.String),
});
export type MonarchTimelineEvent = typeof MonarchTimelineEvent.Type;
export const MonarchTimelineCursor = Schema.Struct({
  at: IsoDateTime,
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
});
export const MonarchTimelineResult = Schema.Struct({
  projectId: ProjectId,
  events: Schema.Array(MonarchTimelineEvent),
  hasOlder: Schema.Boolean,
  nextCursor: Schema.optionalKey(Schema.NullOr(MonarchTimelineCursor)),
  visibilityKey: Schema.optionalKey(Schema.String),
});
export type MonarchTimelineResult = typeof MonarchTimelineResult.Type;
export const MonarchTimelineHistoryInput = Schema.Struct({
  projectId: ProjectId,
  visibilityKey: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(MonarchTimelineCursor),
});
export type MonarchTimelineHistoryInput = typeof MonarchTimelineHistoryInput.Type;
export const MonarchTimelineHistoryResult = Schema.Struct({
  projectId: ProjectId,
  events: Schema.Array(MonarchTimelineEvent),
  nextCursor: Schema.NullOr(MonarchTimelineCursor),
  visibilityKey: Schema.String,
});
export type MonarchTimelineHistoryResult = typeof MonarchTimelineHistoryResult.Type;
