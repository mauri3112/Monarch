import { createFileRoute } from "@tanstack/react-router";

import { HostedEmptyState } from "../components/HostedEmptyState";
import { ProjectLibrary } from "../monarch/ProjectLibrary";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }
  return <ProjectLibrary />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
