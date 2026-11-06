#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

class IconRenderError extends Schema.TaggedError<IconRenderError>()("IconRenderError", {
  cause: Schema.Defect(),
}) {}

const renderPng = (source: string, size: number) =>
  Effect.tryPromise({
    try: () => sharp(Buffer.from(source), { density: 300 }).resize(size, size).png().toBuffer(),
    catch: (cause) => new IconRenderError({ cause }),
  });

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const source = yield* fs.readFileString(path.join(root, "assets/monarch.svg"));
  // macOS reserves a 100px transparent margin around the 824px icon body.
  const macSource = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><svg x="100" y="100" width="824" height="824" viewBox="0 0 64 64">${source.replace(/<svg[^>]*>|<\/svg>/g, "")}</svg></svg>`;
  const outputs = new Map<string, Uint8Array>();
  const pngs = new Map<number, Buffer>();
  for (const size of new Set([...WINDOWS_ICON_SIZES, 180, 1024])) {
    pngs.set(size, yield* renderPng(source, size));
  }
  const macPng = yield* renderPng(macSource, 1024);
  const windowsIco = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: pngs.get(size)! })),
  );
  const webIco = encodePngIco([16, 32, 48].map((size) => ({ size, contents: pngs.get(size)! })));

  for (const filename of Object.values(BRAND_ASSET_PATHS)) {
    if (filename.endsWith(".icon")) continue;
    if (filename.endsWith(".ico")) {
      outputs.set(filename, filename.includes("windows") ? windowsIco : webIco);
    } else {
      const size = filename.includes("180") ? 180 : filename.match(/-(16|32)x/)?.[1];
      outputs.set(filename, filename.includes("macos") ? macPng : pngs.get(Number(size ?? 1024))!);
    }
  }
  for (const { sourceRelativePath, targetRelativePath } of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    outputs.set(targetRelativePath, outputs.get(sourceRelativePath)!);
  }
  for (const filename of ["assets/prod/logo.svg", "apps/web/public/monarch-mark.svg"]) {
    outputs.set(filename, Buffer.from(source));
  }

  const stale: Array<string> = [];
  for (const [filename, contents] of outputs) {
    const destination = path.join(root, filename);
    const current = yield* fs.readFile(destination).pipe(Effect.option);
    if (current._tag === "Some" && Buffer.from(current.value).equals(contents)) continue;
    if (checkOnly) {
      stale.push(filename);
    } else {
      yield* fs.writeFile(destination, contents);
      yield* Console.log(`wrote ${filename}`);
    }
  }
  if (stale.length > 0) {
    return yield* Effect.fail(`Run vp run icons:export to update: ${stale.join(", ")}`);
  }
  yield* Console.log(`${outputs.size} Monarch icons ${checkOnly ? "verified" : "exported"}.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  { check: Flag.Boolean("check").pipe(Flag.withDefault(false)) },
  ({ check }) => exportBrandIcons(check),
).pipe(Command.withDescription("Export Monarch icons from assets/monarch.svg."));

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
