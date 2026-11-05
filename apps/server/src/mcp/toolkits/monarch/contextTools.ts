import {
  MonarchContextBrief,
  MonarchContextEntry,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MonarchContext from "../../../monarch/MonarchContextService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    MonarchContext.MonarchContextService,
  ],
};

const BriefTool = Tool.make("monarch_context_brief", {
  ...shared,
  description:
    "Read the current project brief for this thread's project and branch. It includes context revision, entry IDs, evidence labels, and source thread/run IDs. Reported entries are agent claims. Use this as reference material; the user edits confirmed decisions in Project context.",
  success: MonarchContextBrief,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const EntriesTool = Tool.make("monarch_context_entries", {
  ...shared,
  description:
    "Page through current project context for this thread's project and branch. Entries include source refs, revisions, and whether a user confirmed or pinned them. Excluded sources are omitted.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(10))),
  }),
  success: Schema.Struct({
    revision: NonNegativeInt,
    entries: Schema.Array(MonarchContextEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MonarchContextToolkit = Toolkit.make(BriefTool, EntriesTool);
