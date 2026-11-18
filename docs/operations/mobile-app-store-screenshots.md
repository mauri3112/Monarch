# Mobile app-store screenshot harness

> For maintainers. Using T3 Code? See [docs/user](../user/).

The screenshot harness runs the real mobile application against three disposable local T3
environments. It creates an isolated base directory and server for each environment, real Git
projects with deterministic content, seeded orchestration projections, and persisted terminal
history. The app pairs with every server through its normal connection flow and React Navigation
opens the production Home, Thread, ThreadTerminal, ThreadReview, and SettingsEnvironments routes.

No screenshot-specific screen recreates application UI. `EXPO_PUBLIC_SHOWCASE=1` only enables the
non-rendering pairing/readiness coordinator, disables terminal autofocus so captures do not contain
the software keyboard, and supplies deterministic T3 Connect discovery rows to the real
Environments screen. The local environment cards always come from real paired servers.

## Capture the default matrix

From the repository root:

    pnpm screenshots:mobile

The command:

1. Creates three temporary T3 base directories and starts a local server for each on an available
   port.
2. Creates T3 Code, React, and Linux Git repositories with recognizable favicons, feature branches,
   and a deterministic T3 Code review diff.
3. Seeds each server's migrated SQLite database with playful threads, messages, activities, and
   terminal history, then adds two persisted mobile-outbox tasks waiting to send.
4. Starts an isolated Metro server, builds the iOS app, and boots each device.
5. Pairs each clean app installation with Moonbase Terminal, Suspense Station, and Kernel Cabin.
6. Navigates to the real application route for every requested scene.
7. Sets the requested system appearance and palette, normalizes status bars, converts captures to 24-bit RGB PNGs without alpha, and
   validates dimensions, aspect ratio, file size, and screenshot count before succeeding.
8. Writes store-ready folders beneath `artifacts/app-store/screenshots/` that can be uploaded
   directly to App Store Connect.

The servers, Metro, temporary root directory, and devices started by the runner are cleaned up after
capture. Pass `--keep-running` to retain them for inspection; the runner prints the base-directory
paths and server ports.

Captures wait for the real environment snapshot to hydrate and for the requested route to become
active. The app records readiness in the simulator container. A final settle
delay allows native terminal and Git review data to finish rendering.

A full capture regenerates the selected native project with Expo's clean production prebuild before
building it. Use --skip-build for repeated captures after the first build.

The harness uses fixed Metro port `8199`, which separates it from Expo's normal default port but is
shared across every checkout. The readiness check only verifies that the port is open; it does not
verify process ownership. Concurrent screenshot harnesses in different worktrees can therefore
collide or attach to the wrong Metro process.

Every configured device defaults to dark appearance and the `t3-code` palette, so plain
`pnpm screenshots:mobile` produces 27 dark PNGs. Pass `--appearance light`, `--appearance dark`, or
`--appearance both` to override the configured appearance; `both` produces 54 PNGs.

Pass `--theme <id>` (repeatable) or `--theme all` to capture the app's other palettes: `t3-code`,
`t3-chat`, `grove`, `ocean`, `ember`, and `iris`. The runner hands the palette to the app as a launch
argument, the app applies it to both color schemes, and a scene only reports itself ready once the
requested palette is active — so a capture can never show the previous theme. `--theme all`
multiplies the run by six; only the native build is shared.

The default matrix is:

| Output folder                           | Capture target                 | Upload dimensions | Store slot                                |
| --------------------------------------- | ------------------------------ | ----------------- | ----------------------------------------- |
| `apple/iphone-6.9/dark/t3-code/`        | disposable iPhone 17 Pro Max   | 1320×2868         | App Store Connect iPhone 6.9-inch         |
| `apple/iphone-6.5/dark/t3-code/`        | disposable iPhone 14 Plus      | 1284×2778         | App Store Connect iPhone 6.5-inch         |
| `apple/iphone-duo-closed/dark/t3-code/` | iPhone Duo, folded portrait    | 1398×2034         | App Store Connect iPhone Duo              |
| `apple/iphone-duo-open/dark/t3-code/`   | iPhone Duo, unfolded landscape | 2853×2007         | App Store Connect iPhone Duo              |
| `apple/ipad-13/dark/t3-code/`           | iPad Pro 13-inch (M5)          | 2752×2064         | App Store Connect iPad 13-inch, landscape |

Each target captures thread, terminal, review, thread list, and environments, and every target except
the iPad and Duo also captures agent activity. Each palette folder contains five or six screenshots.
The two Duo folders each contain five scenes and upload to the same iPhone Duo slot (ten images
total). They omit agent activity to stay within that shared limit. Duo capture requires
an installed iOS runtime that supports iPhone Duo and `agent-device` on PATH, or
`AGENT_DEVICE_PATH` pointing to its executable; it sets and verifies the
simulator fold pose before launching the app.

Every palette gets its own leaf folder so one upload slot never mixes themes and each folder keeps a
store-legal screenshot count.

The agent-activity scene shows what a user sees away from the app. The app stages the same Live
Activity the relay would publish for four seeded threads. The runner locks the simulator and pushes the matching approval alert using `simctl push`. Locking
the simulator and answering the notification permission prompt use
[AXe](https://github.com/cameroncooke/AXe), so install it (`brew tap cameroncooke/axe && brew
install axe`) or set `AXE_PATH` before capturing iOS. The iPad skips the scene because the lock
screen does not follow the app's landscape self-rotation.

The generated tree is deliberately aligned with the store upload fields:

    artifacts/app-store/screenshots/
    ├── apple/
    │   ├── iphone-6.9/dark/t3-code/{thread,terminal,review,threads,environments,agent-activity}.png
    │   ├── iphone-6.5/dark/t3-code/{thread,terminal,review,threads,environments,agent-activity}.png
    │   ├── iphone-duo-closed/dark/t3-code/{thread,terminal,review,threads,environments}.png
    │   ├── iphone-duo-open/dark/t3-code/{thread,terminal,review,threads,environments}.png
    │   └── ipad-13/dark/t3-code/{thread,terminal,review,threads,environments}.png

A light-only run writes the same tree under `light/`; `--appearance both` writes both appearance
folders, and each requested theme adds a sibling folder next to `t3-code/`.

Edit [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts) to change simulator names, light/dark appearance, default palette, iOS orientation, scenes, output directory, capture
delay, or viewport. The selectable palette ids come from `MOBILE_THEME_IDS` in
[themePalettes.ts](../../packages/shared/src/themePalettes.ts), so the harness and the app's
appearance settings can never drift apart.

## Capture in GitHub Actions

The upstream-only `Mobile Showcase Screenshots` workflow captures iPhone and iPad on macOS. Select an appearance and palette. The workflow retains its `app-store-connect-screenshots` artifact for 14 days.

## Fast iteration

Capture one scene or device:

    pnpm screenshots:mobile --device iphone-duo-closed --device iphone-duo-open
    pnpm screenshots:mobile --device iphone-6.9 --scene thread

Override the configured appearance or capture both variants:

    pnpm screenshots:mobile --appearance light
    pnpm screenshots:mobile --appearance dark
    pnpm screenshots:mobile --appearance both

Capture other palettes:

    pnpm screenshots:mobile --device iphone-6.9 --theme ocean
    pnpm screenshots:mobile --device iphone-6.9 --theme ocean --theme ember
    pnpm screenshots:mobile --device iphone-6.9 --theme all

Reuse the native build and retain the disposable environment:

    pnpm screenshots:mobile --device ipad-13 --skip-build --keep-running

By default, let the screenshot runner start Metro on port `8199`. To keep Metro in a separate
terminal, start it with the same showcase environment and explicit harness port:

    cd apps/mobile
    APP_VARIANT=development EXPO_PUBLIC_SHOWCASE=1 pnpm exec expo start --dev-client --port 8199

Then run the capture from the repository root:

    pnpm screenshots:mobile --skip-build --skip-metro --device iphone-6.9

`pnpm --filter @t3tools/mobile showcase` starts Expo on its normal port, so it is not compatible with
the harness's `--skip-metro` mode.

List the matrix and flags:

    pnpm screenshots:mobile --list

Validate existing files without starting Metro, servers, simulators, or emulators:

    pnpm screenshots:mobile --validate-only
    pnpm screenshots:mobile --platform ios --validate-only

## Customize the seeded environment

- Project repository, thread projections, conversation, terminal transcript, and Git changes:
  [mobile-showcase-environment.ts](../../scripts/mobile-showcase-environment.ts)
- Device and capture matrix:
  [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts)
- Simulator/emulator orchestration:
  [mobile-showcase.ts](../../scripts/mobile-showcase.ts)

Fixture timestamps are generated relative to capture startup so every route shows stable relative
labels while the server still receives valid current data. The same deterministic three-environment
ensemble serves iPhone and iPad captures; responsive differences
come entirely from the production app layout.

The Pending rows use the production offline outbox and point at the real T3 Code and React fixture
projects. Showcase coordination holds those two entries in the outbox for capture, just like a task
currently open for editing, so reconnecting the seeded environments cannot deliver and remove them
before the screenshot is taken.

The Environments capture presents the three local fixture transports as a Tailscale HTTPS hostname,
a Helsinki VPS hostname, and a Tailnet IPv4 address. This display-only substitution keeps the cards
remote-first while the harness retains reliable loopback connections to its ephemeral servers.

## Local prerequisites

- iOS: Xcode command-line tools, the configured simulator runtimes, and installed CocoaPods.

The harness is the source of truth for upload dimensions; do not resize its output. If store rules
change, update the target's `storeAsset` specification. Capture fails when a PNG is the wrong size,
has alpha, is not 8-bit RGB, exceeds the configured file-size limit, or leaves a full output set below its store minimum.
