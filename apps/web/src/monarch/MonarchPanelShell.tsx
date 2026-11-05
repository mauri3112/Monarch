import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";

export function MonarchPanelShell({
  title,
  description,
  presentation = "sheet",
  open,
  onClose,
  children,
}: {
  title: string;
  description: ReactNode;
  presentation?: "sheet" | "docked" | undefined;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (presentation === "docked") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-monarch-docked-panel>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4 @max-[799px]/monarch:pl-(--workspace-titlebar-content-left)">
          <div className="min-w-0">
            <h2 className="text-base font-medium tracking-tight">{title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={`Close ${title}`} onClick={onClose}>
            <XIcon />
          </Button>
        </header>
        {children}
      </div>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetPopup className="w-[min(100vw,34rem)] max-w-[34rem]" side="right" layer="dialog">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetPopup>
    </Sheet>
  );
}
