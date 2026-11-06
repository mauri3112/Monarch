import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const EntityId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMaxLength(16_000));
const Notes = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))).check(
  Schema.isMaxLength(32),
);
export const MonarchTargetStatus = Schema.Literals([
  "draft",
  "active",
  "paused",
  "achieved",
  "archived",
]);
export type MonarchTargetStatus = typeof MonarchTargetStatus.Type;
const TargetFields = {
  title: Title,
  description: Text,
  indicators: Notes,
  constraints: Notes,
  status: MonarchTargetStatus,
};
export const MonarchTarget = Schema.Struct({
  id: EntityId,
  projectId: ProjectId,
  ...TargetFields,
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MonarchTarget = typeof MonarchTarget.Type;
export const MonarchProjectInput = Schema.Struct({
  projectId: ProjectId,
  focusSuggestionId: Schema.optionalKey(EntityId),
});
export type MonarchProjectInput = typeof MonarchProjectInput.Type;
export const MonarchCreateTargetInput = Schema.Struct({ projectId: ProjectId, ...TargetFields });
export type MonarchCreateTargetInput = typeof MonarchCreateTargetInput.Type;
export const MonarchUpdateTargetInput = Schema.Struct({
  projectId: ProjectId,
  id: EntityId,
  expectedRevision: PositiveInt,
  ...TargetFields,
});
export type MonarchUpdateTargetInput = typeof MonarchUpdateTargetInput.Type;
export const MonarchTargetReference = Schema.Struct({ targetId: EntityId, revision: PositiveInt });
const SuggestionFields = {
  title: Title,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  rationale: Text,
  targets: Schema.Array(MonarchTargetReference).check(Schema.isMaxLength(32)),
  sourceThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(32)),
};
export const NextThreadSuggestion = Schema.Struct({
  id: EntityId,
  projectId: ProjectId,
  ...SuggestionFields,
  status: Schema.Literals(["suggested", "dismissed", "used"]),
  revision: PositiveInt,
  usedThreadId: Schema.NullOr(ThreadId),
  draftThreadId: Schema.NullOr(ThreadId),
  modelSelection: Schema.optionalKey(ModelSelection),
  sourceRunId: Schema.optionalKey(EntityId),
  contextRevision: Schema.optionalKey(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NextThreadSuggestion = typeof NextThreadSuggestion.Type;
export const MonarchCreateSuggestionInput = Schema.Struct({
  projectId: ProjectId,
  ...SuggestionFields,
  dedupeKey: Schema.optionalKey(EntityId),
  modelSelection: Schema.optionalKey(ModelSelection),
  sourceRunId: Schema.optionalKey(EntityId),
  contextRevision: Schema.optionalKey(NonNegativeInt),
});
export type MonarchCreateSuggestionInput = typeof MonarchCreateSuggestionInput.Type;
const SuggestionMutation = { projectId: ProjectId, id: EntityId, expectedRevision: PositiveInt };
export const MonarchSuggestionInput = Schema.Struct(SuggestionMutation);
export type MonarchSuggestionInput = typeof MonarchSuggestionInput.Type;
export const MonarchUpdateSuggestionInput = Schema.Struct({
  ...SuggestionMutation,
  title: Title,
  prompt: SuggestionFields.prompt,
  targets: Schema.optionalKey(SuggestionFields.targets),
  contextRevision: Schema.optionalKey(NonNegativeInt),
});
export type MonarchUpdateSuggestionInput = typeof MonarchUpdateSuggestionInput.Type;
export const MonarchSetSuggestionStatusInput = Schema.Struct({
  ...SuggestionMutation,
  status: Schema.Literals(["suggested", "dismissed"]),
});
export type MonarchSetSuggestionStatusInput = typeof MonarchSetSuggestionStatusInput.Type;
export const MonarchUseSuggestionInput = Schema.Struct({
  ...SuggestionMutation,
  threadId: ThreadId,
});
export type MonarchUseSuggestionInput = typeof MonarchUseSuggestionInput.Type;
export const MonarchProjectState = Schema.Struct({
  targets: Schema.Array(MonarchTarget),
  suggestions: Schema.Array(NextThreadSuggestion),
  hasMoreHistory: Schema.Boolean,
});
export type MonarchProjectState = typeof MonarchProjectState.Type;
export class MonarchError extends Schema.TaggedError<MonarchError>()("MonarchError", {
  reason: Schema.Literals([
    "not_found",
    "conflict",
    "invalid_reference",
    "invalid_state",
    "invalid_input",
    "capacity",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "This project or planning item is no longer available.";
      case "conflict":
        return "This item changed. Refresh it before saving again.";
      case "invalid_reference":
        return "A referenced target or thread is unavailable in this project.";
      case "invalid_state":
        return "This suggestion cannot be used or changed in its current state.";
      case "invalid_input":
        return "Check the planning item fields and try again.";
      case "capacity":
        return "This project has 200 open suggestions. Use or remove one before adding another.";
      case "storage":
        return "Could not save or load this project's planning items.";
    }
  }
}
