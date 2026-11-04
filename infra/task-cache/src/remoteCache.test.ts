import { describe, expect, it } from "vite-plus/test";
import { remoteCacheUrl } from "./remoteCache.ts";

describe("Monarch task cache", () => {
  it("ignores inherited upstream cache configuration", () => {
    expect(remoteCacheUrl("/unused", {})).toBeUndefined();
    expect(
      remoteCacheUrl("/unused", {
        VP_REMOTE_CACHE_URL: "https://legacy.example.com/cache",
        T3_TASK_CACHE_READ_TOKEN: "legacy-token",
      }),
    ).toBeUndefined();
  });

  it("uses an explicitly configured Monarch cache only", () => {
    expect(remoteCacheUrl("/unused", { MONARCH_TASK_CACHE_URL: "  " })).toBeUndefined();
    expect(
      remoteCacheUrl("/unused", { MONARCH_TASK_CACHE_URL: " https://cache.example.com/project " }),
    ).toBe("https://cache.example.com/project");
  });
});
