import { OrchestratorMcpFailure, type MonarchContextError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MonarchContext from "../../../monarch/MonarchContextService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { MonarchContextToolkit } from "./contextTools.ts";

const callerProject = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Project context tools need a calling thread to select its project.",
    });
  return { projectId: caller.projectId, branch: caller.branch };
});
const contextFailure = (error: MonarchContextError) =>
  error.reason === "storage"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(MonarchContextToolkit, {
  monarch_context_brief: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const service = yield* MonarchContext.MonarchContextService;
      return yield* service.brief(yield* callerProject).pipe(Effect.mapError(contextFailure));
    }),
  ),
  monarch_context_entries: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* MonarchContext.MonarchContextService;
      const { projectId, branch } = yield* callerProject;
      const state = yield* service.get({ projectId }).pipe(Effect.mapError(contextFailure));
      const visible = state.entries.filter(
        (entry) => entry.scope === "project" || (branch !== null && entry.branch === branch),
      );
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 5);
      return {
        revision: state.revision,
        entries: visible.slice(start, end),
        nextCursor: end < visible.length ? end : null,
      };
    }),
  ),
});
