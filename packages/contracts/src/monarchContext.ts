import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Body = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
export const MonarchContextSettings = Schema.Struct({
  enabled: Schema.Boolean,
  autoUpdateContext: Schema.Boolean,
  suggestAfterWork: Schema.Boolean,
  suggestAfterTargetChange: Schema.Boolean,
  paused: Schema.Boolean,
  modelSelection: Schema.NullOr(ModelSelection),
  maxUpdatesPerDay: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
  maxOpenSuggestions: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
  excludedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(200)),
  instructions: Schema.String.check(Schema.isMaxLength(4_000)),
  brief: Schema.String.check(Schema.isMaxLength(8_000)),
});
export type MonarchContextSettings = typeof MonarchContextSettings.Type;
export const MonarchContextSource = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
});
const EntryFields = {
  kind: Schema.Literals(["overview", "architecture", "decision", "question", "outcome"]),
  title: Title,
  body: Body,
  scope: Schema.Literals(["project", "branch"]),
  branch: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  sourceRefs: Schema.Array(MonarchContextSource).check(Schema.isMaxLength(20)),
  contradictsEntryIds: Schema.Array(Id).check(Schema.isMaxLength(20)),
};
export const MonarchGeneratedContextEntry = Schema.Struct(EntryFields);
export type MonarchGeneratedContextEntry = typeof MonarchGeneratedContextEntry.Type;
export const MonarchContextEntry = Schema.Struct({
  ...EntryFields,
  id: Id,
  projectId: ProjectId,
  evidence: Schema.Literals(["reported", "confirmed"]),
  origin: Schema.Literals(["user", "agent"]),
  pinned: Schema.Boolean,
  revision: PositiveInt,
  contextRevision: PositiveInt,
  generationId: Schema.NullOr(Id),
  removedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MonarchContextEntry = typeof MonarchContextEntry.Type;
export const MonarchContextProjectInput = Schema.Struct({ projectId: ProjectId });
export type MonarchContextProjectInput = typeof MonarchContextProjectInput.Type;
export const MonarchContextState = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  settingsRevision: NonNegativeInt,
  enabledAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  settings: MonarchContextSettings,
  entries: Schema.Array(MonarchContextEntry),
});
export type MonarchContextState = typeof MonarchContextState.Type;
export const MonarchContextUpdateSettingsInput = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: NonNegativeInt,
  settings: MonarchContextSettings,
});
export type MonarchContextUpdateSettingsInput = typeof MonarchContextUpdateSettingsInput.Type;
export const MonarchContextUpsertEntryInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.optionalKey(Id),
  expectedRevision: Schema.optionalKey(PositiveInt),
  ...EntryFields,
  evidence: Schema.Literals(["reported", "confirmed"]),
  pinned: Schema.Boolean,
});
export type MonarchContextUpsertEntryInput = typeof MonarchContextUpsertEntryInput.Type;
export const MonarchContextEntryInput = Schema.Struct({
  projectId: ProjectId,
  entryId: Id,
  expectedRevision: PositiveInt,
});
export type MonarchContextEntryInput = typeof MonarchContextEntryInput.Type;
export const MonarchContextRestoreEntryInput = Schema.Struct({
  ...MonarchContextEntryInput.fields,
  restoreRevision: Schema.optionalKey(PositiveInt),
});
export type MonarchContextRestoreEntryInput = typeof MonarchContextRestoreEntryInput.Type;
export const MonarchContextHistoryInput = Schema.Struct({
  projectId: ProjectId,
  entryId: Schema.optionalKey(Id),
  beforeSequence: Schema.optionalKey(PositiveInt),
});
export type MonarchContextHistoryInput = typeof MonarchContextHistoryInput.Type;
export const MonarchContextHistoryItem = Schema.Struct({
  sequence: PositiveInt,
  action: Schema.Literals(["created", "updated", "removed", "restored"]),
  entry: MonarchContextEntry,
});
export const MonarchContextHistory = Schema.Struct({
  items: Schema.Array(MonarchContextHistoryItem),
  nextBeforeSequence: Schema.NullOr(PositiveInt),
});
export type MonarchContextHistory = typeof MonarchContextHistory.Type;
export const MonarchContextApplyGeneratedInput = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: NonNegativeInt,
  generationId: Id,
  entries: Schema.Array(MonarchGeneratedContextEntry).check(Schema.isMaxLength(20)),
});
export type MonarchContextApplyGeneratedInput = typeof MonarchContextApplyGeneratedInput.Type;
export const MonarchContextSourceScopeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
});
export type MonarchContextSourceScopeInput = typeof MonarchContextSourceScopeInput.Type;
export const MonarchContextSourceScope = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});
export type MonarchContextSourceScope = typeof MonarchContextSourceScope.Type;
export const MonarchContextBriefInput = Schema.Struct({
  projectId: ProjectId,
  branch: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
});
export type MonarchContextBriefInput = typeof MonarchContextBriefInput.Type;
export const MonarchContextBrief = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  text: Schema.String,
  entryIds: Schema.Array(Id),
  truncated: Schema.Boolean,
});
export type MonarchContextBrief = typeof MonarchContextBrief.Type;
export class MonarchContextError extends Schema.TaggedError<MonarchContextError>()(
  "MonarchContextError",
  {
    reason: Schema.Literals([
      "not_found",
      "conflict",
      "invalid_input",
      "invalid_reference",
      "unknown_scope",
      "excluded_source",
      "capacity",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The project or context entry is unavailable.";
      case "conflict":
        return "Project context changed. Reload it before saving.";
      case "invalid_input":
        return "Check the context fields and try again.";
      case "invalid_reference":
        return "A context source does not belong to this project or is unavailable.";
      case "unknown_scope":
        return "This run has no recorded workspace scope. Its context was not imported.";
      case "excluded_source":
        return "This context uses an excluded thread.";
      case "capacity":
        return "This project has 200 current context entries. Remove an older entry before adding another.";
      case "storage":
        return "Project context could not be saved or loaded.";
    }
  }
}
