import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createMonarchEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    schedules: {
      list: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:schedules:list",
        tag: WS_METHODS.monarchSchedulesList,
      }),
      live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "monarch:schedules:live",
        tag: WS_METHODS.monarchSchedulesSubscribe,
      }),
      upsert: createEnvironmentRpcCommand(runtime, {
        label: "monarch:schedules:upsert",
        tag: WS_METHODS.monarchSchedulesUpsert,
      }),
      setEnabled: createEnvironmentRpcCommand(runtime, {
        label: "monarch:schedules:setEnabled",
        tag: WS_METHODS.monarchSchedulesSetEnabled,
      }),
      remove: createEnvironmentRpcCommand(runtime, {
        label: "monarch:schedules:remove",
        tag: WS_METHODS.monarchSchedulesRemove,
      }),
      runNow: createEnvironmentRpcCommand(runtime, {
        label: "monarch:schedules:runNow",
        tag: WS_METHODS.monarchSchedulesRunNow,
      }),
      history: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:schedules:history",
        tag: WS_METHODS.monarchSchedulesHistory,
      }),
    },

    projectState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "monarch:project-state",
      tag: WS_METHODS.monarchSubscribe,
    }),
    createTarget: createEnvironmentRpcCommand(runtime, {
      label: "monarch:createTarget",
      tag: WS_METHODS.monarchCreateTarget,
    }),
    updateTarget: createEnvironmentRpcCommand(runtime, {
      label: "monarch:updateTarget",
      tag: WS_METHODS.monarchUpdateTarget,
    }),
    createSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "monarch:createSuggestion",
      tag: WS_METHODS.monarchCreateSuggestion,
    }),
    updateSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "monarch:updateSuggestion",
      tag: WS_METHODS.monarchUpdateSuggestion,
    }),
    setSuggestionStatus: createEnvironmentRpcCommand(runtime, {
      label: "monarch:setSuggestionStatus",
      tag: WS_METHODS.monarchSetSuggestionStatus,
    }),
    prepareSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "monarch:prepareSuggestion",
      tag: WS_METHODS.monarchPrepareSuggestion,
    }),
    markSuggestionUsed: createEnvironmentRpcCommand(runtime, {
      label: "monarch:markSuggestionUsed",
      tag: WS_METHODS.monarchMarkSuggestionUsed,
    }),
  };
}
