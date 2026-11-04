import { useState } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { useElementWidthBelow } from "./useElementWidthBelow";

function SizedConversation({ width }: { width: number }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const narrow = useElementWidthBelow(element, 981);
  return (
    <div ref={setElement} style={{ width }}>
      <output>{narrow ? "sheet" : "inline"}</output>
    </div>
  );
}

it("uses the conversation width and updates after a pane resize without a viewport resize", async () => {
  await using screen = await render(<SizedConversation width={1100} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("inline");
  await screen.rerender(<SizedConversation width={600} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("sheet");
  await screen.rerender(<SizedConversation width={1100} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("inline");
});
