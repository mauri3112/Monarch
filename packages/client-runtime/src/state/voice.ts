import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createVoiceEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    capability: createEnvironmentRpcCommand(runtime, {
      label: "voice:capability",
      tag: WS_METHODS.voiceCapability,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "voice:start",
      tag: WS_METHODS.voiceStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, { label: "voice:stop", tag: WS_METHODS.voiceStop }),
    state: createEnvironmentRpcCommand(runtime, {
      label: "voice:state",
      tag: WS_METHODS.voiceState,
    }),
  };
}
