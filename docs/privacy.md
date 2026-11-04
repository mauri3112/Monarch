# Data in Monarch

Monarch is a local, open source app. The source MVP does not include a hosted
Monarch account service or a built-in analytics destination.

Projects, conversations, settings, and provider state are stored on the computer
running the Monarch server, normally under `~/.monarch`. Browser clients also
store settings and connection credentials locally. Protect these directories and
browser profiles as you would other development tools containing private work.

When you send a message or approve work, the selected provider receives the
content and context needed to perform that work under its own terms. Tools may
read or change project files according to the permissions you grant. Connecting
a remote environment sends requests to that environment.

Codex voice brainstorming sends microphone audio to OpenAI after you explicitly
start a session and grant microphone access. Voice transcripts become part of the
thread. Closing the voice session stops the microphone. Availability depends on
your Codex app-server version and account; a ChatGPT subscription does not imply
that every experimental voice route is supported.

Analytics are disabled by default. An operator can enable them only by supplying
an endpoint and key as well as `MONARCH_TELEMETRY_ENABLED=true`. Optional hosted
services and remote build caches also require explicit configuration. Review the
configuration of any independently operated deployment you connect to.

Diagnostic reports can contain local file paths, project names, and error
details. Review them before sharing. Do not publish pairing links, access tokens,
databases, recordings, or private project content in issues or test artifacts.
