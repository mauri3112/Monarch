import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import type { TimelineSelection } from "./MonarchDockContext";

export type MonarchProjectDocument =
  | {
      readonly kind: "thread";
      readonly threadRef: ScopedThreadRef;
      readonly title?: string;
      readonly suggestionId?: string;
    }
  | {
      readonly kind: "draft";
      readonly draftId: DraftId;
      readonly title?: string;
      readonly suggestionId?: string;
    }
  | { readonly kind: "suggestion"; readonly suggestionId: string; readonly title: string }
  | {
      readonly kind: "journal";
      readonly runId: string;
      readonly revision: number;
      readonly title: string;
    };

export interface ProjectDocumentTab {
  readonly id: string;
  readonly document: MonarchProjectDocument;
  readonly selection: TimelineSelection | null;
}

export function projectDocumentKey(
  projectRef: ScopedProjectRef,
  document: MonarchProjectDocument,
): string {
  const identity =
    document.kind === "thread"
      ? scopedThreadKey(document.threadRef)
      : document.kind === "draft"
        ? document.draftId
        : document.kind === "suggestion"
          ? document.suggestionId
          : `${document.runId}:${document.revision}`;
  return `${scopedProjectKey(projectRef)}:${document.kind}:${identity}`;
}

export function documentThreadTarget(document: MonarchProjectDocument): ThreadRouteTarget | null {
  return document.kind === "thread"
    ? { kind: "server", threadRef: document.threadRef }
    : document.kind === "draft"
      ? { kind: "draft", draftId: document.draftId }
      : null;
}

export function documentTitle(document: MonarchProjectDocument): string {
  return document.title || (document.kind === "draft" ? "Draft thread" : "Thread");
}

/** Only a document's actual owner can restore its graph selection. */
export function projectDocumentSelection(
  document: MonarchProjectDocument,
  origin?: TimelineSelection | null,
): TimelineSelection | null {
  if (document.kind === "journal")
    return {
      entityKind: "journal",
      entityId: document.runId,
      eventId: `journal:${document.runId}:${document.revision}`,
    };
  const owner =
    document.kind === "thread"
      ? { entityKind: "thread" as const, entityId: document.threadRef.threadId }
      : document.kind === "suggestion" || (document.kind === "draft" && document.suggestionId)
        ? { entityKind: "suggestion" as const, entityId: document.suggestionId! }
        : null;
  return owner && origin?.entityKind === owner.entityKind && origin.entityId === owner.entityId
    ? origin
    : owner;
}

export function openProjectDocumentTab(
  tabs: readonly ProjectDocumentTab[],
  projectRef: ScopedProjectRef,
  document: MonarchProjectDocument,
  promotedDraftId?: DraftId | null,
  origin?: TimelineSelection | null,
): { tabs: readonly ProjectDocumentTab[]; tab: ProjectDocumentTab } {
  const key = projectDocumentKey(projectRef, document);
  const existing =
    tabs.find((tab) => projectDocumentKey(projectRef, tab.document) === key) ??
    (document.kind === "suggestion"
      ? tabs.find(
          (tab) =>
            (tab.document.kind === "draft" || tab.document.kind === "thread") &&
            tab.document.suggestionId === document.suggestionId,
        )
      : undefined) ??
    (promotedDraftId
      ? tabs.find(
          (tab) => tab.document.kind === "draft" && tab.document.draftId === promotedDraftId,
        )
      : undefined);
  const retainedSuggestionId =
    existing?.document.kind === "draft" || existing?.document.kind === "thread"
      ? existing.document.suggestionId
      : undefined;
  const nextDocument =
    (document.kind === "draft" || document.kind === "thread") &&
    retainedSuggestionId &&
    !document.suggestionId
      ? { ...document, suggestionId: retainedSuggestionId }
      : document;
  const titledDocument =
    existing?.document.title &&
    (!nextDocument.title ||
      nextDocument.title === "Draft thread" ||
      nextDocument.title === "Suggested thread" ||
      nextDocument.title === "Thread")
      ? { ...nextDocument, title: existing.document.title }
      : nextDocument;
  const tab = {
    id: existing?.id ?? key,
    document: titledDocument,
    selection: projectDocumentSelection(titledDocument, origin ?? existing?.selection),
  };
  return {
    tabs: existing ? tabs.map((item) => (item.id === existing.id ? tab : item)) : [...tabs, tab],
    tab,
  };
}
