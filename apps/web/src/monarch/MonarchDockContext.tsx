import { createContext, useContext } from "react";

export type MonarchDockKind = "context" | "settings" | "included";

export interface MonarchDockController {
  readonly activeKind: MonarchDockKind | null;
  readonly host: HTMLElement | null;
  readonly open: (kind: MonarchDockKind, branch?: string | null) => void;
  readonly close: () => void;
  readonly updateIncludedBranch: (branch: string | null) => void;
}

export const MonarchDockContext = createContext<MonarchDockController | null>(null);

export function useMonarchDock(): MonarchDockController | null {
  return useContext(MonarchDockContext);
}
