import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["win32", "darwin", "linux"] as const)(
  "isolates profiles on %s without importing T3 credentials or drafts",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "monarch-profile-" });
      const state = '{"os_crypt":{"encrypted_key":"upstream-key"}}';
      for (const sourceName of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        const source = path.join(directory, sourceName);
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.writeFileString(path.join(source, "Local State"), state);
      }
      for (const isDevelopment of [false, true]) {
        const destination = yield* resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment,
          platform,
        });
        assert.equal(destination, path.join(directory, isDevelopment ? "monarch-dev" : "monarch"));
        assert.isFalse(yield* fs.exists(destination));
        const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
        yield* legacy.load(destination);
        assert.isTrue(Option.isNone(yield* legacy.take));
        yield* legacy.complete;
        assert.isFalse(yield* fs.exists(destination));
      }
      assert.equal(yield* fs.readFileString(path.join(directory, "t3code", "Local State")), state);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, DesktopLegacyLocalStorage.layer])),
);
