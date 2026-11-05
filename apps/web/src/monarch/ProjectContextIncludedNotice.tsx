import type { ScopedProjectRef } from "@t3tools/contracts";
import { boundedProjectContextSnapshot } from "@t3tools/shared/monarchContext";
import { BookOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { monarchEnvironment } from "../state/monarch";
import { useEnvironmentQuery } from "../state/query";

/** The bounded provider context prepared for the next message in this branch. */
export function ProjectContextIncludedNotice({
  projectRef,
  branch,
}: {
  projectRef: ScopedProjectRef;
  branch?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const stateQuery = useEnvironmentQuery(
    monarchEnvironment.context.live({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const query = useEnvironmentQuery(
    monarchEnvironment.context.brief({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        ...(branch ? { branch } : {}),
      },
    }),
  );
  const lastScopeRevision = useRef<string | null>(null);
  const revision = stateQuery.data?.revision;
  const scopeRevision =
    revision === undefined
      ? null
      : `${projectRef.environmentId}:${projectRef.projectId}:${branch ?? ""}:${revision}`;
  const refreshBrief = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the one-shot brief query in step with the live project revision
  useEffect(() => {
    if (scopeRevision === null) return;
    if (lastScopeRevision.current !== scopeRevision) {
      refreshBrief();
    }
    lastScopeRevision.current = scopeRevision;
  }, [scopeRevision, refreshBrief]);
  const context = query.data ? boundedProjectContextSnapshot(query.data) : null;
  if (!context?.text) return null;

  return (
    <>
      <Button size="xs" variant="ghost-muted" onClick={() => setOpen(true)}>
        <BookOpenIcon /> Project context
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup className="w-[min(100vw,34rem)] max-w-[34rem]" side="right" layer="dialog">
          <SheetHeader>
            <SheetTitle>Context for your next message</SheetTitle>
            <SheetDescription>
              Project context revision {context.revision}
              {branch ? ` for ${branch}` : ""}. This is the bounded context prepared for the next
              message.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            {context.truncated ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Shortened to fit the provider limit.
              </p>
            ) : null}
            <pre className="font-sans text-xs leading-relaxed whitespace-pre-wrap break-words">
              {context.text}
            </pre>
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
