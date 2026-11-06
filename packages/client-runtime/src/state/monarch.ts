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
    timeline: {
      history: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:timeline:history",
        tag: WS_METHODS.monarchTimelineHistory,
      }),
      live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "monarch:timeline:live",
        tag: WS_METHODS.monarchTimelineSubscribe,
      }),
    },
    continuity: {
      refresh: createEnvironmentRpcCommand(runtime, {
        label: "monarch:continuity:refresh",
        tag: WS_METHODS.monarchContinuityRefresh,
      }),
      activity: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "monarch:continuity:activity",
        tag: WS_METHODS.monarchContinuitySubscribe,
      }),
      sources: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:continuity:sources",
        tag: WS_METHODS.monarchContinuitySources,
      }),
    },
    context: {
      get: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:context:get",
        tag: WS_METHODS.monarchContextGet,
      }),
      live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "monarch:context:live",
        tag: WS_METHODS.monarchContextSubscribe,
      }),
      history: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:context:history",
        tag: WS_METHODS.monarchContextHistory,
      }),
      brief: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "monarch:context:brief",
        tag: WS_METHODS.monarchContextBrief,
      }),
      updateSettings: createEnvironmentRpcCommand(runtime, {
        label: "monarch:context:updateSettings",
        tag: WS_METHODS.monarchContextUpdateSettings,
      }),
      upsertEntry: createEnvironmentRpcCommand(runtime, {
        label: "monarch:context:upsertEntry",
        tag: WS_METHODS.monarchContextUpsertEntry,
      }),
      removeEntry: createEnvironmentRpcCommand(runtime, {
        label: "monarch:context:removeEntry",
        tag: WS_METHODS.monarchContextRemoveEntry,
      }),
      restoreEntry: createEnvironmentRpcCommand(runtime, {
        label: "monarch:context:restoreEntry",
        tag: WS_METHODS.monarchContextRestoreEntry,
      }),
    },
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
