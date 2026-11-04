import { type ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useEffectEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useClientSettings } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../state/server";
import { readProject } from "../state/entities";

export function BootstrapProjectExpansion() {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload?.bootstrapProjectId) return;
    const bootstrapProject = readProject(
      scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
    );
    const bootstrapProjectKey =
      (bootstrapProject
        ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
        : null) ??
      (serverConfig?.cwd
        ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
        : null) ??
      scopedProjectKey(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
    useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands the bootstrap project in the optional thread sidebar when the server welcomes this client
  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);
  return null;
}
