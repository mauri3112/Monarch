import { Persistence } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

import { readStoredBrowserDpopKey } from "./cloud/dpop";
import * as ConnectionStorage from "./connection/storage";

function opened(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function seedDatabase(
  name: string,
  version: number,
  store: string,
  key: string,
  value: unknown,
) {
  const request = indexedDB.open(name, version);
  request.addEventListener("upgradeneeded", () => request.result.createObjectStore(store));
  const database = await opened(request);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
  database.close();
}

it("starts with its own connection catalog and DPoP key without opening T3 databases", async () => {
  const databases = [
    "t3code:connection-runtime",
    "t3code:cloud-auth",
    "monarch:connection-runtime",
    "monarch:cloud-auth",
  ];
  await using _databases = {
    async [Symbol.asyncDispose]() {
      for (const name of databases) {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.addEventListener("success", () => resolve(), { once: true });
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
      }
    },
  };
  await seedDatabase(
    "t3code:connection-runtime",
    4,
    "catalog",
    "document",
    "private upstream catalog",
  );
  await seedDatabase("t3code:cloud-auth", 1, "keys", "relay-dpop-proof-key", {
    thumbprint: "upstream-proof-key",
  });
  using open = vi.spyOn(indexedDB, "open");
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The browser runner cannot load @effect/vitest; this tests real IndexedDB isolation.
  const targets = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Persistence.ConnectionTargetStore;
      return yield* store.list;
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );
  expect(targets).toEqual([]);
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The browser runner cannot load @effect/vitest; this tests real IndexedDB isolation.
  expect(await Effect.runPromise(readStoredBrowserDpopKey())).toBeNull();
  expect(open.mock.calls.map(([name]) => name)).toEqual([
    "monarch:connection-runtime",
    "monarch:cloud-auth",
  ]);
});

it("ignores upstream UI history and leaves legacy records untouched when saving Monarch state", async () => {
  const legacyKeys = [
    "t3code:ui-state:v1",
    "t3code:renderer-state:v8",
    "codething:renderer-state:v4",
  ];
  const legacy = JSON.stringify({
    projectOrder: ["private-project"],
    threadLastVisitedAtById: { "private-thread": "2026-11-04T00:00:00Z" },
  });
  using _storage = {
    [Symbol.dispose]() {
      for (const key of [...legacyKeys, "monarch:ui-state:v1"]) localStorage.removeItem(key);
    },
  };
  for (const key of legacyKeys) localStorage.setItem(key, legacy);
  const { useUiStateStore, persistState } = await import("./uiStateStore");
  expect(useUiStateStore.getState().projectOrder).toEqual([]);
  expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
  persistState(useUiStateStore.getState());
  expect(localStorage.getItem("monarch:ui-state:v1")).not.toBeNull();
  for (const key of legacyKeys) expect(localStorage.getItem(key)).toBe(legacy);
});
