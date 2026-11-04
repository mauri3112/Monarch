import { useLayoutEffect, useState } from "react";

import { observeResize } from "../lib/observeResize";

export function useElementWidthBelow(element: HTMLElement | null, threshold: number): boolean {
  const [below, setBelow] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the conversation container after split-pane and sidebar resizes
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setBelow(width < threshold);
    };
    measure();
    return observeResize(element, measure);
  }, [element, threshold]);
  return below;
}
