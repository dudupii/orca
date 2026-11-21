# The `speak` MCP tool for terminal agents

A model running in an Orca terminal (a `claude` or `codex` CLI in a pty) can
speak a short briefing on the user's phone by calling the `speak` MCP tool.
Orca wires that tool into the structured agent sessions it launches itself
whenever a voice-capable phone is connected; a CLI started in a terminal gets
no injection, so this note covers wiring it by hand. The wiring is a
per-session chore: the address and token below are fixed for one run of Orca,
but every start mints a new token and re-publishes the file with a newly
selected port — the port may repeat the previous one and the host stays
`127.0.0.1`, so after a restart always wire from the file as it reads then.

That chore only exists on the machine Orca runs on. The commands and paths
here assume the CLI shares the Orca desktop process's host and network
namespace, where `127.0.0.1` is Orca's loopback and the home directory is the
one Orca writes under. Orca also runs terminal panes elsewhere — on remote
SSH hosts, and on Windows inside WSL distros — where `127.0.0.1` and these
paths belong to the remote or guest environment. Orca provides no relay or
forwarding to the speak endpoint for them, so this wiring does not reach them
as written; those terminals keep the fallback readout described next.

None of this is required for voice mode itself to speak. Its fallback readout
condenses each session reply and reads it aloud on the phone, on by default,
with nothing to configure.

## The endpoint file

The desktop runtime starts a loopback-only MCP server (bound to `127.0.0.1`)
when Orca launches and publishes its address to `<userData>/speak/speak-endpoint.json`:

- Linux: `~/.config/Orca/speak/speak-endpoint.json`
- macOS: `~/Library/Application Support/Orca/speak/speak-endpoint.json`
- Windows: `%APPDATA%\Orca\speak\speak-endpoint.json`

The file is owner-only (0600 inside a 0700 directory) because it carries the
auth token, and it holds exactly:

```json
{ "port": 41234, "token": "0f2b6c56-9a1e-4c8d-b7f3-2e5a8c1d4b6e" }
```

The server URL is `http://127.0.0.1:<port>/mcp`; the token travels in the
`x-orca-speak-token` request header, never in the URL. When Orca quits it
deliberately leaves the file behind — a stale file fails closed — so the
file's existence proves nothing; only a running Orca does.

## Wiring the claude CLI

Run this on the machine Orca runs on, in the directory the terminal agent
works in (the default scope, `local`, is private to you and bound to that
project):

```sh
claude mcp add --transport http orca-speak http://127.0.0.1:<port>/mcp \
  --header "x-orca-speak-token: <token>"
```

Re-adding an existing name errors ("already exists in local config"), so after
an Orca restart re-read the endpoint file and refresh the entry in two steps:

```sh
claude mcp remove orca-speak
claude mcp add --transport http orca-speak http://127.0.0.1:<port>/mcp \
  --header "x-orca-speak-token: <token>"
```

`-s user` installs the entry for every project instead — the token still
rotates with each Orca run, whatever the scope.

## Wiring the codex CLI

`codex mcp add` has no flag for custom headers, so edit `~/.codex/config.toml`
(the entry is global, not per project):

```toml
[mcp_servers.orca-speak]
url = "http://127.0.0.1:<port>/mcp"

[mcp_servers.orca-speak.http_headers]
"x-orca-speak-token" = "<token>"
```

After an Orca restart, re-read the endpoint file and update the url and token
in place (or `codex mcp remove orca-speak`, then re-add the block).

## What the tool does

`speak` takes `text` (required) plus optional `lang` (a locale hint for
pronunciation; omitted, the phone picks its own language) and `session`. It is
fire-and-forget: the call returns `Speak broadcast queued.` immediately and
never waits for the phone, audio, or playback. Leave `session` out — nothing
filters on it today, and a broadcast without it reaches every phone with
voice mode running.

On the phone, voice mode speaks the latest briefing that arrived while one of
its voice turns was running — verbatim, in place of that turn's fallback
readout. A briefing that lands while no turn is running is dropped; nothing
interrupts idle listening to play it.

Structured Claude and Codex spawns also get a briefing style appended to
their prompt; a structured ACP spawn has no prompt carrier and gets the tool
alone. To match that in a terminal agent, add the same wording to its
instructions (`CLAUDE.md`, `AGENTS.md`, or a system prompt):

> A paired phone is listening: the `speak` tool reads a short briefing aloud
> there. Close meaningful work with one spoken briefing - briefings over
> readouts, prose over lists - and keep the written reply for the details.
> Speaking is optional: skip it when there is nothing worth hearing aloud.

## Troubleshooting

- **403 from the endpoint** — the token is wrong or stale. Orca restarted and
  rotated it: re-read the endpoint file and wire the fresh values.
- **The file exists but nothing listens** — it is a leftover from the previous
  run, left behind on purpose: Orca is not running. Start Orca and re-wire
  from the file it then publishes — the port it names may repeat the old one
  or not.
- **"already exists in local config" (claude)** — remove the entry before
  re-adding it; see the refresh recipe above.
