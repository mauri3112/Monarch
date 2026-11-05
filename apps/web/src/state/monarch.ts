import { createMonarchEnvironmentCommands } from "@t3tools/client-runtime/state/monarch";
import { connectionAtomRuntime } from "../connection/runtime";

export const monarchEnvironment = createMonarchEnvironmentCommands(connectionAtomRuntime);
