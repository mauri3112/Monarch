import {
  MonarchCreateSuggestionInput,
  MonarchCreateTargetInput,
  MonarchProjectState,
  MonarchSetSuggestionStatusInput,
  MonarchTarget,
  MonarchUpdateSuggestionInput,
  MonarchUpdateTargetInput,
  NextThreadSuggestion,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Monarch from "../../../monarch/MonarchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Monarch.MonarchService,
  ],
};

const omitProjectId = <T extends { readonly projectId: unknown }>(fields: T) => {
  const { projectId: _projectId, ...rest } = fields;
  return rest;
};

const PlanReadTool = Tool.make("monarch_plan_read", {
  ...shared,
  description:
    "Read targets and suggested next threads for this thread's project. Suggestions include target revisions and source thread IDs. Use current revisions when changing an item.",
  success: MonarchProjectState,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const TargetCreateTool = Tool.make("monarch_target_create", {
  ...shared,
  description:
    "Save a target for this thread's project after the user explicitly agrees to its wording and status. A target is a goal, not permission to start work. Set confirmedByUser to true only after that agreement.",
  parameters: Schema.Struct({
    ...omitProjectId(MonarchCreateTargetInput.fields),
    confirmedByUser: Schema.Literal(true),
  }),
  success: MonarchTarget,
}).annotate(Tool.Destructive, true);

const TargetUpdateTool = Tool.make("monarch_target_update", {
  ...shared,
  description:
    "Replace a target's fields after the user explicitly agrees to the change. Achievement also needs their confirmation. Pass the revision from monarch_plan_read; a stale revision fails.",
  parameters: Schema.Struct({
    ...omitProjectId(MonarchUpdateTargetInput.fields),
    confirmedByUser: Schema.Literal(true),
  }),
  success: MonarchTarget,
}).annotate(Tool.Destructive, true);

const SuggestionCreateTool = Tool.make("monarch_suggestion_create", {
  ...shared,
  description:
    "Save one proposed next thread for this thread's project. This creates a suggestion only; it does not start work. Cite source thread IDs and current active target revisions when available.",
  parameters: Schema.Struct({
    title: MonarchCreateSuggestionInput.fields.title,
    prompt: MonarchCreateSuggestionInput.fields.prompt,
    rationale: MonarchCreateSuggestionInput.fields.rationale,
    targets: MonarchCreateSuggestionInput.fields.targets,
    sourceThreadIds: MonarchCreateSuggestionInput.fields.sourceThreadIds,
  }),
  success: NextThreadSuggestion,
}).annotate(Tool.Destructive, true);

const SuggestionUpdateTool = Tool.make("monarch_suggestion_update", {
  ...shared,
  description:
    "Edit a suggested thread's title and prompt after the user agrees. Use its current revision. This does not start the thread.",
  parameters: Schema.Struct({
    ...omitProjectId(MonarchUpdateSuggestionInput.fields),
    confirmedByUser: Schema.Literal(true),
  }),
  success: NextThreadSuggestion,
}).annotate(Tool.Destructive, true);

const SuggestionStatusTool = Tool.make("monarch_suggestion_status", {
  ...shared,
  description:
    "Dismiss or restore a suggested next thread after the user asks. Use its current revision. Dismissing removes it from the active suggestions list but keeps its record.",
  parameters: Schema.Struct({
    ...omitProjectId(MonarchSetSuggestionStatusInput.fields),
    confirmedByUser: Schema.Literal(true),
  }),
  success: NextThreadSuggestion,
}).annotate(Tool.Destructive, true);

export const MonarchToolkit = Toolkit.make(
  PlanReadTool,
  TargetCreateTool,
  TargetUpdateTool,
  SuggestionCreateTool,
  SuggestionUpdateTool,
  SuggestionStatusTool,
);
