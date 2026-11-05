import { OrchestratorMcpFailure, type MonarchError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Monarch from "../../../monarch/MonarchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { MonarchToolkit } from "./tools.ts";

const projectId = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Monarch planning tools need a calling thread to select its project.",
    });
  return caller.projectId;
});

const planningFailure = (error: MonarchError) =>
  error.reason === "storage"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(MonarchToolkit, {
  monarch_plan_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const planning = yield* Monarch.MonarchService;
      return yield* planning
        .list({ projectId: yield* projectId })
        .pipe(Effect.mapError(planningFailure));
    }),
  ),
  monarch_target_create: McpToolAccess.actsAsCaller(({ confirmedByUser: _confirmed, ...input }) =>
    Effect.gen(function* () {
      const planning = yield* Monarch.MonarchService;
      return yield* planning
        .createTarget({ ...input, projectId: yield* projectId })
        .pipe(Effect.mapError(planningFailure));
    }),
  ),
  monarch_target_update: McpToolAccess.actsAsCaller(({ confirmedByUser: _confirmed, ...input }) =>
    Effect.gen(function* () {
      const planning = yield* Monarch.MonarchService;
      return yield* planning
        .updateTarget({ ...input, projectId: yield* projectId })
        .pipe(Effect.mapError(planningFailure));
    }),
  ),
  monarch_suggestion_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const planning = yield* Monarch.MonarchService;
      return yield* planning
        .createSuggestion({ ...input, projectId: yield* projectId })
        .pipe(Effect.mapError(planningFailure));
    }),
  ),
  monarch_suggestion_update: McpToolAccess.actsAsCaller(
    ({ confirmedByUser: _confirmed, ...input }) =>
      Effect.gen(function* () {
        const planning = yield* Monarch.MonarchService;
        return yield* planning
          .updateSuggestion({ ...input, projectId: yield* projectId })
          .pipe(Effect.mapError(planningFailure));
      }),
  ),
  monarch_suggestion_status: McpToolAccess.actsAsCaller(
    ({ confirmedByUser: _confirmed, ...input }) =>
      Effect.gen(function* () {
        const planning = yield* Monarch.MonarchService;
        return yield* planning
          .setSuggestionStatus({ ...input, projectId: yield* projectId })
          .pipe(Effect.mapError(planningFailure));
      }),
  ),
});
