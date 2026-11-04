import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect, useMatches, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { MonarchWorkspace } from "../monarch/MonarchWorkspace";
import {
  CodexBrainstormProjectAction,
  CodexBrainstormThreadAction,
} from "../monarch/brainstorm/CodexBrainstorm";
import { resolveWorkspaceProjectRef } from "../monarch/projectWorkspace.logic";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function projectBrainstormAction(projectRef: ScopedProjectRef) {
  return <CodexBrainstormProjectAction projectRef={projectRef} />;
}

function threadBrainstormAction(threadRef: ScopedThreadRef) {
  return <CodexBrainstormThreadAction threadRef={threadRef} />;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  const projectRef = resolveWorkspaceProjectRef(useParams({ strict: false }));
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const [backgroundProjectRef, setBackgroundProjectRef] = useState(projectRef);
  if (
    !modalOpen &&
    (backgroundProjectRef ? scopedProjectKey(backgroundProjectRef) : null) !==
      (projectRef ? scopedProjectKey(projectRef) : null)
  ) {
    setBackgroundProjectRef(projectRef);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  const shownProjectRef = modalOpen ? backgroundProjectRef : projectRef;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget || shownProjectRef ? (
        <MonarchWorkspace
          target={shownTarget}
          projectRef={shownProjectRef}
          background={modalOpen}
          projectActions={projectBrainstormAction}
          threadActions={threadBrainstormAction}
        />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
