import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import {
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
    readonly args?: ReadonlyArray<string>;
  }) =>
    resolveRootCliCommand("browser setup", input.args).pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "monarch"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/@mauri3112/monarch/dist/bin.mjs";
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo monarch browser setup",
      );
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" monarch browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/@mauri3112/monarch/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe('sudo env "PATH=$PATH" monarch browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the arguments, so root runs setup on the same T3 home", () =>
    Effect.gen(function* () {
      const args = ["--base-dir", "/srv/monarch home"];
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/@mauri3112/monarch/dist/bin.mjs",
          path: yield* pathWithT3,
          args,
        }),
      ).toBe(`sudo env "PATH=$PATH" monarch browser setup --base-dir '/srv/monarch home'`);
      expect(
        yield* rootCommand({
          node: "/opt/monarch/monarch",
          entry: "/opt/monarch/monarch",
          executable: true,
          args,
        }),
      ).toBe("sudo /opt/monarch/monarch browser setup --base-dir '/srv/monarch home'");
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when monarch is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "monarch");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { MONARCH_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      // An unrelated `monarch` on PATH, such as an older npm global, is another install's CLI.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        `sudo '${shim}' browser setup`,
      );

      // The link the app installs onto PATH leads to its own launcher, so plain `monarch` is right.
      const linked = yield* fs.makeTempDirectoryScoped();
      yield* fs.symlink(shim, path.join(linked, "monarch"));
      expect(yield* rootCommand({ ...desktop, path: linked })).toBe(
        'sudo env "PATH=$PATH" monarch browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/monarch/monarch",
          entry: "/opt/monarch/monarch",
          executable: true,
        }),
      ).toBe("sudo /opt/monarch/monarch browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { MONARCH_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" monarch browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "monarch.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.monarch"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\T3 Code\\monarch.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\T3 Code\\monarch.exe",
            "C:\\Program Files\\T3 Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { MONARCH_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.monarch"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'monarch doctor "--base-dir" "C:\\Users\\Jane Doe\\.monarch"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", ["--base-dir", "C:\\T3\\\u201CArchive\u201D"]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\monarch.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\monarch.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('monarch doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { MONARCH_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.monarch'$/,
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for script packages and the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".monarch/runtime/versions/1.0.0/monarch");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/@mauri3112/monarch/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@mauri3112/monarch/bin/monarch.mjs", "npx"],
        ["pnpm/dlx/hash/node_modules/@mauri3112/monarch/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/monarch/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "../package.json"),
          `{"name":"@mauri3112/monarch","version":"${packageJson.version}","bin":{"monarch":"./bin/monarch.mjs"}}`,
        );
        const launchedBy = entry.endsWith("monarch.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { MONARCH_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@mauri3112/monarch");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/monarch");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"@mauri3112/monarch","version":"0.0.45","bin":{"monarch":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix: yield* fs.realPath(prefix) });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated monarch command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the downloaded executable was started by a global npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@mauri3112/monarch");
      const launcher = path.join(packageRoot, "bin/monarch.mjs");
      const executable = path.join(root, ".monarch/runtime/versions/1.0.0/monarch");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/monarch"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { MONARCH_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, { kind: "npm-global", prefix: yield* fs.realPath(prefix) }],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"@mauri3112/monarch","version":"${version}","bin":{"monarch":"./bin/monarch.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/@mauri3112/monarch/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".monarch/runtime/0.0.45/monarch",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
