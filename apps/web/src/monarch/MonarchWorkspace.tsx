import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, FilesIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import {
  Activity,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { useStableCallback } from "../hooks/useStableCallback";
import { useElementWidthBelow } from "../hooks/useElementWidthBelow";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../hooks/useResizableWidth";
import { observeResize } from "../lib/observeResize";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useProject, useQuietThreadProjection, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../threadRoutes";
import { ProjectBoard } from "./ProjectBoard";
import {
  MonarchDockContext,
  type MonarchDockKind,
  type TimelineSelection,
} from "./MonarchDockContext";
import { ProjectActivityDock } from "./ProjectActivityDock";
import { ProjectContextIncludedNotice } from "./ProjectContextIncludedNotice";
import { suggestionIdForDraft } from "./suggestionDraftIdentity";
import { ProjectJournalTab } from "./ProjectJournalTab";
import { useOpenSuggestionDraft } from "./useOpenSuggestionDraft";
import {
  documentThreadTarget,
  documentTitle,
  openProjectDocumentTab,
  projectDocumentKey,
  projectDocumentSelection,
  type MonarchProjectDocument,
  type ProjectDocumentTab,
} from "./projectDocuments";

interface DocumentsState {
  scopeKey: string;
  tabs: readonly ProjectDocumentTab[];
  activeId: string | null;
  observedRouteKey: string | null;
  nativeTarget: ThreadRouteTarget | null;
  visible: boolean;
}

const routeTargetKey = (target: ThreadRouteTarget | null) =>
  target?.kind === "server" ? scopedThreadKey(target.threadRef) : (target?.draftId ?? null);

export function MonarchWorkspace({
  target,
  projectRef: routeProjectRef,
  background = false,
  projectActions,
  threadActions,
}: {
  target: ThreadRouteTarget | null;
  projectRef: ScopedProjectRef | null;
  background?: boolean;
  projectActions?: (projectRef: ScopedProjectRef) => ReactNode;
  threadActions?: (threadRef: ScopedThreadRef) => ReactNode;
}) {
  const navigate = useNavigate();
  const targetKey = routeTargetKey(target);
  const threadRef = target?.kind === "server" ? target.threadRef : null;
  const thread = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? store.getDraftSession(target.draftId)
      : threadRef
        ? store.getDraftSessionByRef(threadRef)
        : null,
  );
  const unlistedThread = useQuietThreadProjection(
    threadRef !== null && thread === null && draft === null ? threadRef : null,
  );
  const threadProjectId =
    thread?.projectId ?? draft?.projectId ?? unlistedThread?.projection.thread.projectId;
  const threadEnvironmentId = threadRef?.environmentId ?? draft?.environmentId;
  const verifiedProjectRef =
    threadProjectId && threadEnvironmentId
      ? scopeProjectRef(threadEnvironmentId, threadProjectId)
      : null;
  const promotedKey =
    target?.kind === "draft" && draft
      ? scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId))
      : null;
  const [routeScopeHint, setRouteScopeHint] = useState<{
    key: string;
    projectRef: ScopedProjectRef;
    promotedKey: string | null;
    pendingFromKey?: string | null;
  } | null>(
    verifiedProjectRef && targetKey
      ? { key: targetKey, projectRef: verifiedProjectRef, promotedKey }
      : null,
  );
  if (
    verifiedProjectRef &&
    targetKey &&
    !(routeScopeHint?.key !== targetKey && routeScopeHint?.pendingFromKey === targetKey) &&
    (routeScopeHint?.key !== targetKey ||
      scopedProjectKey(routeScopeHint.projectRef) !== scopedProjectKey(verifiedProjectRef) ||
      routeScopeHint.promotedKey !== promotedKey)
  ) {
    setRouteScopeHint({ key: targetKey, projectRef: verifiedProjectRef, promotedKey });
  }
  // A scoped tab can navigate to a cold thread before its shell/projection arrives.
  // Only that exact requested route (or reserved draft promotion) inherits the hint;
  // an eventual authoritative project above always wins.
  const projectRef =
    verifiedProjectRef ??
    routeProjectRef ??
    (targetKey && (routeScopeHint?.key === targetKey || routeScopeHint?.promotedKey === targetKey)
      ? routeScopeHint.projectRef
      : null);
  const project = useProject(projectRef);
  const shellStatus = useEnvironmentShellStatus(projectRef?.environmentId ?? null);
  const scopeKey = projectRef ? scopedProjectKey(projectRef) : "none";
  const resolveDraft = useOpenSuggestionDraft(projectRef);
  const routeSuggestionId =
    target?.kind === "draft" && projectRef
      ? suggestionIdForDraft(projectRef, target.draftId)
      : null;
  const routeDocument: MonarchProjectDocument | null =
    target?.kind === "server"
      ? { kind: "thread", threadRef: target.threadRef, title: thread?.title || "Thread" }
      : target?.kind === "draft"
        ? {
            kind: "draft",
            draftId: target.draftId,
            title: routeSuggestionId ? "Suggested thread" : "Draft thread",
            ...(routeSuggestionId ? { suggestionId: routeSuggestionId } : {}),
          }
        : null;
  const initialDocuments = (): DocumentsState => {
    const opened =
      routeDocument && projectRef ? openProjectDocumentTab([], projectRef, routeDocument) : null;
    return {
      scopeKey,
      tabs: opened?.tabs ?? [],
      activeId: opened?.tab.id ?? null,
      observedRouteKey: targetKey,
      nativeTarget: target,
      visible: target !== null,
    };
  };
  const [documentState, setDocumentState] = useState<DocumentsState>(initialDocuments);
  const retainedDraftId =
    documentState.scopeKey === scopeKey && documentState.nativeTarget?.kind === "draft"
      ? documentState.nativeTarget.draftId
      : null;
  const promotedRef = useComposerDraftStore((store) =>
    retainedDraftId ? store.getPromotedDraftRedirect(retainedDraftId) : null,
  );
  const serverDraftId = useComposerDraftStore((store) =>
    threadRef ? store.getDraftIdByRef(threadRef) : null,
  );
  let documents = documentState.scopeKey === scopeKey ? documentState : initialDocuments();
  if (documents.observedRouteKey !== targetKey) {
    if (routeDocument && projectRef) {
      const promotedDraftId =
        target?.kind === "server" &&
        promotedRef &&
        scopedThreadKey(promotedRef) === scopedThreadKey(target.threadRef)
          ? retainedDraftId
          : serverDraftId;
      const previousNative = documents.tabs.find((tab) => tab.id === documents.activeId)?.document;
      const metadata =
        previousNative?.kind === "draft" || previousNative?.kind === "thread"
          ? previousNative.suggestionId
          : undefined;
      const nextDocument =
        metadata && promotedDraftId ? { ...routeDocument, suggestionId: metadata } : routeDocument;
      const opened = openProjectDocumentTab(
        documents.tabs,
        projectRef,
        nextDocument,
        promotedDraftId,
      );
      documents = {
        ...documents,
        tabs: opened.tabs,
        activeId: opened.tab.id,
        observedRouteKey: targetKey,
        nativeTarget: target,
        visible: true,
      };
    } else {
      const active = documents.tabs.find((tab) => tab.id === documents.activeId)?.document;
      documents = {
        ...documents,
        observedRouteKey: targetKey,
        visible: active?.kind === "thread" || active?.kind === "draft" ? false : documents.visible,
      };
    }
  }
  if (documents !== documentState) setDocumentState(documents);
  const readDocuments = useStableCallback(() => documents);
  const updateDocuments = setDocumentState;
  const pendingSuggestions = useRef(new Map<string, Promise<ThreadRouteTarget | null>>());
  const suggestionCompletions = useRef(new Set<string>());
  const tabGenerations = useRef(new Map<string, number>());
  const [actionHost, setActionHost] = useState<HTMLElement | null>(null);
  const [documentError, setDocumentError] = useState<{
    scopeKey: string;
    id: string;
    message: string;
  } | null>(null);
  const [documentHost, setDocumentHost] = useState<HTMLElement | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hoverState, setHoveredEntityKey] = useState<{ scopeKey: string; value: string | null }>({
    scopeKey,
    value: null,
  });
  const hoveredEntityKey = hoverState.scopeKey === scopeKey ? hoverState.value : null;
  const [selectionState, setSelection] = useState<{
    scopeKey: string;
    value: TimelineSelection | null;
  }>({ scopeKey, value: null });
  const selection = selectionState.scopeKey === scopeKey ? selectionState.value : null;
  const selectionIntent = useRef<{ scopeKey: string; value: TimelineSelection | null } | null>(
    null,
  );
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const controlPanel = useRef<HTMLElement | null>(null);
  const focusAfterClose = useRef<string | null>(null);
  const documentDomId = useId();
  const panelDomId = `${documentDomId}-panel`;
  const tabDomId = (id: string) => `${documentDomId}-tab-${encodeURIComponent(id)}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- returns DOM focus to the surviving tab or Timeline after a document tab closes
  useLayoutEffect(() => {
    const destination = focusAfterClose.current;
    if (destination === null) return;
    focusAfterClose.current = null;
    const survivingTab = documents.tabs.some((tab) => tab.id === destination)
      ? tabButtons.current.get(destination)
      : null;
    (survivingTab ?? controlPanel.current)?.focus({ preventScroll: true });
  }, [documents]);
  const [dockState, setDockState] = useState<{
    scopeKey: string;
    kind: MonarchDockKind | null;
    targetKey: string | null;
    branch: string | null;
  }>({ scopeKey, kind: "timeline", targetKey: null, branch: null });
  if (
    dockState.scopeKey !== scopeKey ||
    (dockState.kind === "included" && dockState.targetKey !== targetKey)
  )
    setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
  const activeDock =
    dockState.scopeKey === scopeKey &&
    (dockState.kind !== "included" || dockState.targetKey === targetKey)
      ? dockState.kind
      : "timeline";
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1280);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bounds follow the actual workspace when sidebars or the window resize
  useLayoutEffect(() => {
    if (!workspaceElement) return;
    const measure = () => setWorkspaceWidth(workspaceElement.clientWidth);
    measure();
    return observeResize(workspaceElement, measure);
  }, [workspaceElement]);
  const compact = useElementWidthBelow(workspaceElement, 800);
  const activeTab = documents.tabs.find((tab) => tab.id === documents.activeId) ?? null;
  const activeDocument = activeTab?.document ?? null;
  const documentsOpen = documents.visible && activeDocument !== null;
  const boardVisible =
    (!expanded || !documentsOpen) &&
    !timelineExpanded &&
    (documentsOpen ? workspaceWidth >= 1500 : activeDock === null || !compact);
  const boardSized = boardVisible && documentsOpen;
  const boardWidth = useResizableWidth({
    storageKey: "monarch:project-board-width",
    defaultWidth: 320,
    minWidth: 280,
    maxWidth: Math.max(280, workspaceWidth - 720),
    edge: "right",
  });
  const documentWidth = useResizableWidth({
    storageKey: `monarch:document-width:${scopeKey}`,
    defaultWidth: 600,
    minWidth: 360,
    maxWidth: Math.max(360, workspaceWidth - (boardSized ? boardWidth.width : 0) - 320),
    edge: "left",
  });
  const controlWidth = useResizableWidth({
    storageKey: `monarch:project-dock-width:${scopeKey}`,
    defaultWidth: 540,
    minWidth: 300,
    maxWidth: Math.max(300, workspaceWidth - 300),
    edge: "left",
  });
  const controlVisible =
    activeDock !== null && (!expanded || !documentsOpen) && (!compact || !documentsOpen);
  const controlSized = controlVisible && boardVisible && !documentsOpen;
  const nativeActive = activeDocument?.kind === "thread" || activeDocument?.kind === "draft";
  const nativeVisible = documentsOpen && nativeActive;
  const nativeThreadRef =
    documents.nativeTarget?.kind === "server" ? documents.nativeTarget.threadRef : null;

  const navigateTarget = (next: ThreadRouteTarget) => {
    const nextKey = routeTargetKey(next);
    if (projectRef && nextKey)
      setRouteScopeHint({ key: nextKey, projectRef, promotedKey: null, pendingFromKey: targetKey });
    if (next.kind === "server")
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(next.threadRef),
      });
    else void navigate({ to: "/draft/$draftId", params: { draftId: next.draftId } });
  };
  const showTimeline = () => {
    updateDocuments({ ...readDocuments(), visible: false });
    setExpanded(false);
    setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
  };
  const selectDocumentOwner = (tab: ProjectDocumentTab) => {
    const owner = projectDocumentSelection(tab.document, tab.selection);
    selectionIntent.current = { scopeKey, value: owner };
    setSelection({ scopeKey, value: owner });
    setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
  };
  const activateTab = (tab: ProjectDocumentTab) => {
    selectDocumentOwner(tab);
    const nextTarget = documentThreadTarget(tab.document);
    updateDocuments({
      ...readDocuments(),
      activeId: tab.id,
      visible: true,
      ...(nextTarget ? { nativeTarget: nextTarget } : {}),
    });
    setExpanded(false);
    setTimelineExpanded(false);
    if (nextTarget) navigateTarget(nextTarget);
  };
  const closeTab = (id: string) => {
    setExpanded(false);
    const current = readDocuments();
    const closing = current.tabs.find((tab) => tab.id === id);
    if (!closing) return;
    tabGenerations.current.set(id, (tabGenerations.current.get(id) ?? 0) + 1);
    const tabs = current.tabs.filter((tab) => tab.id !== id);
    const nextTab =
      current.activeId === id
        ? (tabs.at(-1) ?? null)
        : (tabs.find((tab) => tab.id === current.activeId) ?? null);
    const nextTarget = nextTab ? documentThreadTarget(nextTab.document) : null;
    focusAfterClose.current = nextTab?.id ?? "timeline";
    if (nextTab) selectDocumentOwner(nextTab);
    else setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
    updateDocuments({
      ...current,
      tabs,
      activeId: nextTab?.id ?? null,
      visible: nextTab !== null,
      ...(nextTarget ? { nativeTarget: nextTarget } : {}),
    });
    if (current.activeId === id && nextTarget) navigateTarget(nextTarget);
    else if (
      documentThreadTarget(closing.document) &&
      routeTargetKey(documentThreadTarget(closing.document)) === targetKey &&
      projectRef
    )
      void navigate({ to: "/workspace/$environmentId/$projectId", params: projectRef });
  };
  const openDocument = (document: MonarchProjectDocument) => {
    if (!projectRef) return;
    if (document.kind === "thread" && document.threadRef.environmentId !== projectRef.environmentId)
      return;
    const current = readDocuments();
    const origin =
      selectionIntent.current?.scopeKey === scopeKey ? selectionIntent.current.value : selection;
    const opened = openProjectDocumentTab(current.tabs, projectRef, document, null, origin);
    selectDocumentOwner(opened.tab);
    const nextTarget = documentThreadTarget(opened.tab.document);
    updateDocuments({
      ...current,
      tabs: opened.tabs,
      activeId: opened.tab.id,
      visible: true,
      ...(nextTarget ? { nativeTarget: nextTarget } : {}),
    });
    setExpanded(false);
    setTimelineExpanded(false);
    if (nextTarget) navigateTarget(nextTarget);
    setDocumentError(null);
    if (document.kind !== "suggestion") return;
    const requestKey = `${scopeKey}:${document.suggestionId}`;
    let promise = pendingSuggestions.current.get(requestKey);
    if (!promise) {
      promise = resolveDraft.resolveSuggestion(document.suggestionId);
      pendingSuggestions.current.set(requestKey, promise);
      const request = promise;
      const cleanup = () => {
        if (pendingSuggestions.current.get(requestKey) === request)
          pendingSuggestions.current.delete(requestKey);
      };
      void promise.then(cleanup, cleanup);
    }
    const generation = tabGenerations.current.get(opened.tab.id) ?? 0;
    const completionKey = `${requestKey}:${generation}`;
    if (suggestionCompletions.current.has(completionKey)) return;
    suggestionCompletions.current.add(completionKey);
    void promise
      .then((nextTarget) => {
        const latest = readDocuments();
        if (
          !nextTarget ||
          latest.scopeKey !== scopeKey ||
          (tabGenerations.current.get(opened.tab.id) ?? 0) !== generation ||
          !latest.tabs.some((tab) => tab.id === opened.tab.id)
        )
          return;
        const converted: MonarchProjectDocument =
          nextTarget.kind === "server"
            ? {
                kind: "thread",
                threadRef: nextTarget.threadRef,
                title: document.title,
                suggestionId: document.suggestionId,
              }
            : {
                kind: "draft",
                draftId: nextTarget.draftId,
                title: document.title,
                suggestionId: document.suggestionId,
              };
        const key = projectDocumentKey(projectRef, converted);
        const tabs = latest.tabs
          .filter(
            (tab) =>
              tab.id === opened.tab.id || projectDocumentKey(projectRef, tab.document) !== key,
          )
          .map((tab) =>
            tab.id === opened.tab.id
              ? {
                  ...tab,
                  document: converted,
                  selection: projectDocumentSelection(converted, tab.selection),
                }
              : tab,
          );
        const active = latest.activeId === opened.tab.id && latest.visible;
        updateDocuments({ ...latest, tabs, ...(active ? { nativeTarget: nextTarget } : {}) });
        if (active) {
          const convertedTab = tabs.find((tab) => tab.id === opened.tab.id);
          if (convertedTab) selectDocumentOwner(convertedTab);
          navigateTarget(nextTarget);
        }
      })
      .catch((cause: unknown) => {
        if (
          readDocuments().scopeKey === scopeKey &&
          (tabGenerations.current.get(opened.tab.id) ?? 0) === generation &&
          readDocuments().tabs.some((tab) => tab.id === opened.tab.id)
        )
          setDocumentError({
            scopeKey,
            id: opened.tab.id,
            message: cause instanceof Error ? cause.message : String(cause),
          });
      })
      .finally(() => suggestionCompletions.current.delete(completionKey));
  };
  const dockController = {
    activeKind: activeDock,
    selection,
    hoveredEntityKey,
    activeDocument,
    documentHost,
    openDocument,
    closeDocument: () => {
      const activeId = readDocuments().activeId;
      if (activeId) closeTab(activeId);
    },
    showTimeline,
    hoverEntity: (value: string | null) => setHoveredEntityKey({ scopeKey, value }),
    selectEntity: (next: TimelineSelection | null) => {
      selectionIntent.current = { scopeKey, value: next };
      setSelection({ scopeKey, value: next });
      setDockState({ scopeKey, kind: "timeline", targetKey: null, branch: null });
      if (compact) showTimeline();
    },
    actionHost,
    setActionHost,
    host: dockHost,
    open: (kind: MonarchDockKind, branch?: string | null) => {
      setDockState({
        scopeKey,
        kind,
        targetKey: kind === "included" ? targetKey : null,
        branch: kind === "included" ? (branch ?? null) : null,
      });
      if (compact) updateDocuments({ ...readDocuments(), visible: false });
    },
    close: () => setDockState({ scopeKey, kind: null, targetKey: null, branch: null }),
    updateIncludedBranch: (branch: string | null) =>
      setDockState((current) =>
        current.scopeKey === scopeKey &&
        current.kind === "included" &&
        current.targetKey === targetKey &&
        current.branch !== branch
          ? { ...current, branch }
          : current,
      ),
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const count = documents.tabs.length;
    const destination =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowLeft"
          ? (index + count - 1) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (destination === null) return;
    event.preventDefault();
    const tab = documents.tabs[destination];
    if (!tab) return;
    activateTab(tab);
    tabButtons.current.get(tab.id)?.focus({ preventScroll: true });
  };
  const sized = (width: number): CSSProperties =>
    ({
      [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
      width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
    }) as CSSProperties;
  return (
    <MonarchDockContext value={dockController}>
      <div
        ref={setWorkspaceElement}
        className="@container/monarch flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        data-thread-open={documents.nativeTarget !== null}
        data-dock-open={activeDock !== null}
        inert={background}
      >
        <section
          className={cn(
            "relative min-h-0 min-w-0 flex-col",
            boardVisible ? "flex" : "hidden",
            boardSized ? "shrink-0 border-r border-border" : "flex-1",
          )}
          style={boardSized ? sized(boardWidth.width) : undefined}
          {...workspaceAreaProps("home", 1, "Project workspace")}
          aria-label="Project workspace"
        >
          <WorkspacePageHeader electron={isElectron}>
            <Button size="sm" variant="ghost" render={<Link to="/" />}>
              <ArrowLeftIcon /> Projects
            </Button>
          </WorkspacePageHeader>
          {project && projectRef ? (
            <ProjectBoard
              key={scopeKey}
              project={project}
              projectRef={projectRef}
              selectedThreadRef={nativeThreadRef}
              actions={projectActions?.(projectRef)}
            />
          ) : (
            <div className="p-6 text-sm text-muted-foreground" role="status">
              {shellStatus === "live" && projectRef ? "Project unavailable" : "Loading project…"}
            </div>
          )}
          {boardSized ? (
            <div
              role="separator"
              aria-label="Resize project workspace"
              aria-orientation="vertical"
              className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
              {...boardWidth.handlers}
            />
          ) : null}
        </section>
        <section
          className={cn(
            "relative min-h-0 min-w-0 flex-col border-l border-border",
            controlVisible ? "flex" : "hidden",
            controlSized ? "shrink-0" : "flex-1",
          )}
          style={controlSized ? sized(controlWidth.width) : undefined}
          aria-label="Project control panel"
          ref={controlPanel}
          tabIndex={-1}
        >
          {!boardVisible || (documents.tabs.length > 0 && !documentsOpen) ? (
            <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
              {!boardVisible ? (
                <Button size="sm" variant="ghost" render={<Link to="/" />}>
                  <ArrowLeftIcon /> Projects
                </Button>
              ) : null}
              {documents.tabs.length > 0 && !documentsOpen ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateDocuments({ ...readDocuments(), visible: true })}
                >
                  <FilesIcon /> Documents {documents.tabs.length}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div
            className={cn("min-h-0 min-w-0 flex-1", activeDock === "timeline" ? "block" : "hidden")}
          >
            {projectRef ? (
              <Activity
                mode={
                  controlVisible && activeDock === "timeline" && !background ? "visible" : "hidden"
                }
              >
                <ProjectActivityDock
                  key={scopeKey}
                  projectRef={projectRef}
                  expanded={timelineExpanded}
                  onToggleExpanded={() => setTimelineExpanded((value) => !value)}
                />
              </Activity>
            ) : null}
          </div>
          <div
            ref={setDockHost}
            className={cn("min-h-0 min-w-0 flex-1", activeDock === "timeline" ? "hidden" : "block")}
            data-monarch-dock-host
          >
            {activeDock === "included" && projectRef ? (
              <ProjectContextIncludedNotice
                projectRef={projectRef}
                branch={dockState.branch}
                panelOnly
                onClose={dockController.close}
              />
            ) : null}
          </div>
          {controlSized ? (
            <div
              role="separator"
              aria-label="Resize project control panel"
              aria-orientation="vertical"
              className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
              {...controlWidth.handlers}
            />
          ) : null}
        </section>
        <section
          className={cn(
            "relative min-h-0 min-w-0 flex-col border-l border-border",
            documentsOpen ? "flex" : "hidden",
            compact || expanded ? "flex-1" : "shrink-0",
          )}
          style={!compact && !expanded ? sized(documentWidth.width) : undefined}
          {...workspaceAreaProps("panel", 4, "Project documents")}
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            {!controlVisible || activeDock !== "timeline" ? (
              <Button size="sm" variant="ghost" onClick={showTimeline}>
                <ArrowLeftIcon /> Timeline
              </Button>
            ) : null}
            <div
              role="tablist"
              aria-orientation="horizontal"
              aria-label="Open project documents"
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
            >
              {documents.tabs.map((tab, index) => (
                <div key={tab.id} className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    role="tab"
                    id={tabDomId(tab.id)}
                    aria-controls={panelDomId}
                    tabIndex={tab.id === documents.activeId ? 0 : -1}
                    ref={(element) => {
                      if (element) tabButtons.current.set(tab.id, element);
                      else tabButtons.current.delete(tab.id);
                    }}
                    onKeyDown={(event) => navigateTabs(event, index)}
                    aria-selected={tab.id === documents.activeId}
                    className="max-w-44 truncate rounded px-2 py-1 text-xs aria-selected:bg-accent"
                    onClick={() => activateTab(tab)}
                  >
                    {documentTitle(tab.document)}
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Close ${documentTitle(tab.document)}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={
                nativeActive
                  ? expanded
                    ? "Show project beside thread"
                    : "Expand thread"
                  : expanded
                    ? "Show Timeline beside document"
                    : "Expand document pane"
              }
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Hide document pane"
              onClick={showTimeline}
            >
              <XIcon />
            </Button>
          </div>
          {nativeThreadRef && nativeActive ? (
            <div className="flex shrink-0 justify-end border-b border-border px-2">
              {threadActions?.(nativeThreadRef)}
            </div>
          ) : null}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            role="tabpanel"
            id={panelDomId}
            aria-labelledby={activeTab ? tabDomId(activeTab.id) : undefined}
          >
            {documentError?.scopeKey === scopeKey && documentError.id === activeTab?.id ? (
              <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">
                {documentError.message}
              </p>
            ) : null}
            <div
              ref={setDocumentHost}
              className={cn(
                "min-h-0 min-w-0",
                activeDocument?.kind === "suggestion"
                  ? "flex-1 overflow-y-auto"
                  : nativeActive && activeDocument.suggestionId
                    ? "shrink-0"
                    : "hidden",
              )}
              data-monarch-document-host
            />
            <section
              className={cn("min-h-0 min-w-0 flex-1 flex-col", nativeVisible ? "flex" : "hidden")}
              aria-label="Thread conversation"
            >
              {documents.nativeTarget ? (
                <ThreadRouteView
                  target={documents.nativeTarget}
                  background={background || !nativeVisible}
                  contained
                />
              ) : null}
            </section>
            {documentsOpen && !background && activeDocument?.kind === "journal" && projectRef ? (
              <ProjectJournalTab
                key={activeTab?.id}
                projectRef={projectRef}
                runId={activeDocument.runId}
                revision={activeDocument.revision}
                onOpenThread={(threadId) =>
                  openDocument({
                    kind: "thread",
                    threadRef: scopeThreadRef(projectRef.environmentId, threadId),
                  })
                }
              />
            ) : null}
          </div>
          {!compact && !expanded ? (
            <div
              role="separator"
              aria-label="Resize document pane"
              aria-orientation="vertical"
              className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
              {...documentWidth.handlers}
            />
          ) : null}
        </section>
      </div>
    </MonarchDockContext>
  );
}
