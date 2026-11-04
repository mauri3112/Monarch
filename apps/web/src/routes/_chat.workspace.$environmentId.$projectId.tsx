import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/workspace/$environmentId/$projectId")({
  component: () => null,
});
