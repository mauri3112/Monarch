# Monarch

Monarch is a standalone, project-first app for working with coding agents. This public source MVP is a fork of [T3 Code](https://github.com/pingdotgg/t3code). The private Monarch plugin is a separate project and is not included here.

The fork keeps T3 Code's provider connectors, event-sourced orchestration, thread history, approvals, and tool execution. Each Monarch project brings together Targets, scheduled tasks, suggested next threads, and its conversations. Codex voice is experimental and depends on the installed app-server and account capabilities. Other providers remain available for text conversations.

For voice, configure Codex to use an existing CLI signed in with ChatGPT. Managed-token setups and API-key authentication are not supported for voice. Open a project, choose **Brainstorm with Codex**, then **Start voice**. Microphone access starts only after that action. Ending voice stops capture, and transcripts remain in the thread.

## Direct a project

Add a Target to describe a direction such as making installation dependable. Several Targets can stay active together. Progress indicators and constraints are optional; editing, pausing, archiving, and marking a Target achieved are explicit decisions. Saving a Target does not start an agent.

Under **Scheduled tasks**, choose **Add task** and select **Run a prompt** or **Suggest next threads**. Running a prompt uses the existing agent workflow and its permission settings. Suggesting next threads examines active Targets and recent completed conversations with a selected Codex or Claude model, and can produce up to three suggestions. Both need the Monarch server to be running. A laptop that is asleep cannot run a scheduled task.

A suggestion task can run daily or weekly in a selected timezone, at an interval, or immediately with **Run now**. Run history records success or failure. After an offline gap, it catches up once rather than replaying every missed occurrence. Suggestion tasks use bounded recent conversation excerpts, so their suggestions do not establish that the repository has been fully inspected or that reported work has been verified.

Suggested next threads show their reasoning, related Targets, and source conversations. **Use** opens an editable draft and leaves sending to you. Reopening that suggestion keeps your draft edits. **Edit** changes the proposed prompt; **Remove** puts it in removed history, where it can be restored. A Target change makes an older suggestion stale until you review its relationship to the new direction. Once you send the draft, its suggestion links to the resulting thread.

Open **Project context** beside the project title to write a brief and retain architecture notes, decisions, questions, and outcomes. Generated entries cite their source conversations and remain **Reported** until you confirm them. Branch-specific work stays scoped to its branch. You can edit, pin, remove, and restore entries; automatic updates preserve your decisions. The relevant context accompanies subsequent conversations across providers without changing your written prompt.

Open **Settings** beside **Suggested next threads** to choose a Codex or Claude model and enable updates after completed work or Target changes. Automatic updates start off. **Build context** can read selected existing conversations first; **Refresh now** requests an update. Settings include exclusions, pause, instructions, daily update limits, and a cap on open suggestions. Activity shows queued work, failures, and retries. An update can make two model requests, one for context and one for suggestions. Timed refreshes use the existing scheduled suggestion tasks. Suggestions remain drafts for you to review and send.

Targets, project context, settings, schedules, run history, and suggestions persist locally. The private plugin's data is not imported automatically.

## Run from source

Use the versions pinned in `package.json`: Node 26.12.1 and pnpm 12.14.0, with [Vite+](https://viteplus.dev/guide/). Install dependencies, then start the local web app:

```sh
vp install
vp run dev --no-seed
```

The runner prints the local URL and ports. Do not set `VITE_HTTP_URL` or `VITE_WS_URL`; development uses a single origin with Vite proxies. For the Electron client, use `vp run dev:desktop --no-seed` after installing its platform dependencies.

Monarch uses `~/.monarch`, or an explicit `MONARCH_HOME` directory. Linked Git worktrees use their own `.monarch` directory for development. It does not reuse T3 Code's `~/.t3` database. Development seeding is off by default. Use synthetic data for public demos and screenshots.

This is a source MVP. There are no supported signed installers, hosted Monarch accounts, managed relay, or automatic release channel. Build and run from a reviewed source revision. Configuring an upstream npm command or installing official T3 Code is not a Monarch update.

## Privacy and configuration

No analytics endpoint or key is built in. The inherited remote build cache is disabled; an independently operated cache requires `MONARCH_TASK_CACHE_URL`. Analytics require explicit `MONARCH_TELEMETRY_ENABLED=true` plus an operator-supplied endpoint and key. The example environment file contains no T3 production service identifiers. The reviewed model catalog is bundled; an operator-supplied catalog requires `MONARCH_MODEL_MANIFEST_URL`. Provider authentication remains with the selected provider, and provider traffic follows its existing connector.

Local provider use does not require a hosted account. Independently hosted services are advanced configuration and are outside this MVP. Keep tokens, pairing links, databases, recordings, and private project files out of Git.

## Upstream baseline

Monarch starts from T3 Code nightly `v0.1.8-nightly.20261104.4179`, commit [`9e85538535c8553901351112ab02dd1dd62db5ee`](https://github.com/pingdotgg/t3code/commit/9e85538535c8553901351112ab02dd1dd62db5ee). Its [upstream release run](https://github.com/pingdotgg/t3code/actions/runs/41845757292) built the desktop targets and passed release checks. This evidence covers the upstream baseline; Monarch's changes have their own checks.

This published nightly was 28 commits ahead of stable `v0.1.7`, including fixes for recovery, diff loading, and provider behavior. It was selected as a fixed baseline instead of following moving `main`. Later upstream changes need their own compatibility review.

Internal `@t3tools/*` package names and protocol identifiers remain to keep upstream integration manageable. The web UI is in `apps/web`; Electron wraps it in `apps/desktop`; provider execution and orchestration live in `apps/server`; shared contracts and client state live in `packages/contracts` and `packages/client-runtime`. Project presentation should preserve existing environment and project identities. Voice extends the Codex adapter boundary; it does not replace the orchestration engine.

The `Monarch CI` workflow runs focused checks on GitHub-hosted runners. Upstream release, deployment, mobile, and maintainer workflows are restricted to the upstream repository. They are retained as reference, not enabled for this fork.

## License and attribution

T3 Code is copyright T3 Tools Inc. The original [MIT license](LICENSE) is preserved verbatim. Retain the existing third-party notices when redistributing source or binaries. Monarch is an independent fork and is not an official T3 Code release.
