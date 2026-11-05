import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectReviewSchedules } from "./ProjectReviewSchedules";

const mocks = vi.hoisted(() => ({
  command: vi.fn(async (_name: string, _input: unknown) => ({ _tag: "Success", value: {} })),
  schedules: [] as Array<Record<string, unknown>>,
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { kind?: string }) => (atom.kind === "providers" ? [] : true),
}));
vi.mock("../state/monarch", () => ({
  monarchEnvironment: {
    schedules: {
      live: () => ({ kind: "live" }),
      history: () => ({ kind: "history" }),
      upsert: { kind: "upsert", permissionAtom: () => ({ kind: "permission" }) },
      setEnabled: { kind: "setEnabled", permissionAtom: () => ({ kind: "permission" }) },
      remove: { kind: "remove", permissionAtom: () => ({ kind: "permission" }) },
      runNow: { kind: "runNow", permissionAtom: () => ({ kind: "permission" }) },
    },
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data: atom?.kind === "history" ? { runs: [] } : { schedules: mocks.schedules },
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) => (input: unknown) =>
    mocks.command(command.kind, input),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => ({ kind: "providers" }) },
  EMPTY_SERVER_PROVIDERS: [],
}));
vi.mock("../state/entities", () => ({
  useProject: () => ({ id: "project-1", environmentId: "environment-1" }),
}));
vi.mock("../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../providerInstances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providerInstances")>()),
  providerInstanceEntriesFor: () => [
    {
      instanceId: "codex",
      driverKind: "codex",
      enabled: true,
      installed: true,
      isAvailable: true,
      snapshot: { auth: { status: "authenticated" } },
      models: [{ slug: "gpt-6-luna", aliases: [] }],
    },
    {
      instanceId: "replay",
      driverKind: "replay",
      enabled: true,
      installed: true,
      isAvailable: true,
      snapshot: { auth: { status: "authenticated" } },
      models: [{ slug: "replay-dev", aliases: [] }],
    },
  ],
}));
vi.mock("../components/settings/scheduledTasksSettings.logic", () => ({
  scheduledTaskDefaultModel: () => ({ instanceId: "codex", model: "gpt-6-luna" }),
}));
vi.mock("../components/chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    instanceEntries,
  }: {
    instanceEntries: Array<{ driverKind: string }>;
  }) => (
    <button type="button">
      Models: {instanceEntries.map((entry) => entry.driverKind).join(", ")}
    </button>
  ),
}));
vi.mock("../confirmDialog", () => ({ requestConfirmDialog: async () => true }));

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);

it("saves a project review with an explicit model and does not run it", async () => {
  mocks.schedules.length = 0;
  mocks.command.mockClear();
  await using screen = await render(
    <ProjectReviewSchedules projectRef={projectRef} archived={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add review" }));
  await expect.element(screen.getByRole("button", { name: "Models: codex" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save review" }));
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  expect(mocks.command.mock.calls[0]?.[0]).toBe("upsert");
  expect(mocks.command.mock.calls[0]?.[1]).toMatchObject({
    environmentId: "environment-1",
    input: {
      projectId: "project-1",
      modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
      recurrence: { type: "daily", timeOfDay: "09:00" },
    },
  });
  expect(mocks.command.mock.calls.some(([name]) => name === "runNow")).toBe(false);
});

it("runs a saved review only from Review now", async () => {
  mocks.command.mockClear();
  mocks.schedules.splice(0, mocks.schedules.length, {
    id: "review-1",
    projectId: "project-1",
    title: "Daily review",
    instructions: "",
    recurrence: { type: "daily", timeOfDay: "09:00" },
    timezone: "Europe/Berlin",
    modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
    enabled: true,
    revision: 2,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "idle",
    lastRunError: null,
  });
  await using screen = await render(
    <ProjectReviewSchedules projectRef={projectRef} archived={false} />,
  );
  expect(mocks.command).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Review now" }));
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  expect(mocks.command.mock.calls[0]).toMatchObject([
    "runNow",
    { environmentId: "environment-1", input: { projectId: "project-1", id: "review-1" } },
  ]);
});
