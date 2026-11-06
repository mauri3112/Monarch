import { ChevronRightIcon, Link2Icon } from "lucide-react";
import {
  timelineRowProps,
  type MonarchDockController,
  type TimelineSelection,
} from "./MonarchDockContext";
import styles from "./ProjectOverviewRow.module.css";

export function ProjectOverviewRow({
  dock,
  kind,
  entityId,
  title,
  subtitle,
  needsInput = false,
}: {
  dock: MonarchDockController;
  kind: TimelineSelection["entityKind"];
  entityId: string;
  title: string;
  subtitle: string;
  needsInput?: boolean;
}) {
  const selected = dock.selection?.entityKind === kind && dock.selection.entityId === entityId;
  const family = kind === "prompt-schedule" || kind === "review-schedule" ? "schedule" : kind;
  return (
    <button
      type="button"
      className={styles.row}
      data-family={family}
      data-needs-input={needsInput}
      data-selected={selected}
      {...timelineRowProps(dock, kind, entityId)}
      aria-pressed={selected}
      onClick={() => dock.selectEntity?.({ entityKind: kind, entityId })}
    >
      <span className={styles.marker} aria-hidden="true">
        {needsInput ? "?" : null}
      </span>
      <span className={styles.copy}>
        <span className={styles.title}>{title}</span>
        <span className={styles.subtitle}>{subtitle}</span>
      </span>
      {selected ? (
        <Link2Icon className={styles.hint} aria-hidden="true" />
      ) : (
        <ChevronRightIcon className={styles.hint} aria-hidden="true" />
      )}
    </button>
  );
}
