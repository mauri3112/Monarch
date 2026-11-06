import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import styles from "./ProjectTimeline.module.css";

export function TimelineHeaderAction({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={styles["project-timeline-command"]}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
