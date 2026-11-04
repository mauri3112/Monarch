import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, FolderIcon, PlusIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAllEnvironmentProjectSnapshotsReady, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";

export function ProjectLibrary() {
  const projects = useProjects();
  const ready = useAllEnvironmentProjectSnapshotsReady();
  const { environments } = useEnvironments();
  const visibleProjects = projects
    .filter((project) => project.archivedAt == null)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );

  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden"
      {...workspaceAreaProps("home", 1, "Projects")}
    >
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">Monarch</span>
      </WorkspacePageHeader>
      <div className="mx-auto w-full max-w-[1200px] overflow-y-auto px-5 py-7 sm:px-12 sm:py-10">
        <div className="mb-8 flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center sm:gap-6">
          <div>
            <h1 className="text-2xl leading-tight font-medium tracking-tight">Projects</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              One place for each project and its conversations.
            </p>
          </div>
          <Button onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon />
            Add project
          </Button>
        </div>
        {visibleProjects.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
            {visibleProjects.map((project) => (
              <Link
                key={scopedProjectKey(scopeProjectRef(project.environmentId, project.id))}
                to="/workspace/$environmentId/$projectId"
                params={{ environmentId: project.environmentId, projectId: project.id }}
                className="flex min-w-0 flex-col rounded-xl border border-border bg-background p-5.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <span className="flex justify-between gap-3 text-muted-foreground">
                  <FolderIcon size={20} aria-hidden="true" />
                  <ArrowUpRightIcon size={16} aria-hidden="true" />
                </span>
                <h2 className="mt-6 text-base font-medium break-words">{project.title}</h2>
                <span className="mt-1 block min-w-0 truncate text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
                <span className="mt-5 block text-2xs break-words text-muted-foreground">
                  {environmentLabels.get(project.environmentId) ?? "Environment unavailable"}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-18 text-center text-muted-foreground"
            role="status"
          >
            <FolderIcon size={28} aria-hidden="true" />
            <h2 className="text-lg font-medium text-foreground">
              {ready ? "Your first project starts here" : "Loading projects…"}
            </h2>
            <p>
              {ready
                ? "Add a folder to bring its threads together."
                : "Waiting for your connected environments."}
            </p>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
