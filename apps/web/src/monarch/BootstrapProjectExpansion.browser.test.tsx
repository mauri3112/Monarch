import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { BootstrapProjectExpansion } from "./BootstrapProjectExpansion";

const mocks = vi.hoisted(() => ({ setProjectExpanded: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: { value: unknown }) => atom.value }));
vi.mock("../state/server", () => ({
  primaryServerConfigAtom: { value: null },
  primaryServerWelcomeAtom: {
    value: {
      environment: { environmentId: "environment" },
      bootstrapProjectId: "bootstrap-project",
      bootstrapThreadId: "bootstrap-thread",
    },
  },
}));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../state/entities", () => ({ readProject: () => null }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: { getState: () => mocks } }));

it.each(["/", "/environment/explicit-thread"])(
  "a server bootstrap leaves the requested %s route in place",
  async (path) => {
    mocks.setProjectExpanded.mockReset();
    await using screen = await render(<BootstrapProjectExpansion />, { router: path });
    await vi.waitFor(() => expect(mocks.setProjectExpanded).toHaveBeenCalled());
    expect(screen.router?.state.location.pathname).toBe(path);
  },
);
