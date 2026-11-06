import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

import { ModelSelection } from "./modelSelection.ts";
import { MonarchGeneratedContextEntry } from "./monarchContext.ts";

export const MonarchJournalRef = Schema.Struct({ runId: RunId, revision: PositiveInt });
export type MonarchJournalRef = typeof MonarchJournalRef.Type;
export const MonarchJournalInput = Schema.Struct({
  projectId: ProjectId,
  ...MonarchJournalRef.fields,
});
export type MonarchJournalInput = typeof MonarchJournalInput.Type;
export const MonarchJournalRecord = Schema.Struct({
  ...MonarchJournalInput.fields,
  threadId: ThreadId,
  threadTitle: Schema.String,
  reviewRunId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  completedAt: IsoDateTime,
  startedAt: IsoDateTime,
  recordedAt: IsoDateTime,
  modelSelection: ModelSelection,
  entries: Schema.Array(MonarchGeneratedContextEntry),
});
export type MonarchJournalRecord = typeof MonarchJournalRecord.Type;
export const MonarchJournalResult = Schema.Struct({ journal: Schema.NullOr(MonarchJournalRecord) });
export type MonarchJournalResult = typeof MonarchJournalResult.Type;

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
  journalRefs: Schema.optionalKey(Schema.Array(MonarchJournalRef)),
  modelStage: Schema.optionalKey(Schema.Literals(["journal", "suggestions"])),
  // Related Project/Work events are references, while parentIds record causation.
  relatedEventIds: Schema.optionalKey(Schema.Array(Schema.String)),
  projectScope: Schema.optionalKey(Schema.Boolean),
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
