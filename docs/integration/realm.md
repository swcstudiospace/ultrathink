# Realm integration

ultrathink reads whether Realm, the sandboxed-workspace runtime, is absent, down, advisory, enforcing or degraded, and it reports that next to its other stack connections. This page is the contract for that read-only seam, what it does and does not give you under Omp, and what ultrathink is asking Realm for. The probe is `probeRealm` in `src/stack/realm.ts`; this page describes it and does not repeat its logic.

## Scope

- This page covers the ultrathink side only. The seam is read-only.
- ultrathink never starts Realm. It never spawns a daemon and never calls `realm up`, `realm mcp`, `realm acp` or `/realm-retry`. The only request it ever sends over the control socket is `status`. When no socket path can be derived it runs the read-only `realm status` command as a child process (`src/stack/realm.ts`), with a neutral working directory and an allow-listed environment (`PATH`, `HOME` and `XDG_CONFIG_HOME`), and it never starts a daemon.
- Realm is optional. With no Realm installed or configured, ultrathink reports `disabled` and carries on.
- Changes to Realm are requests, not edits. This repository does not change Realm, and nothing here is promised as done on the Realm side. The requests are listed under [Requests for Realm](#requests-for-realm).
- To turn the probe off, set `ULTRATHINK_REALM=off`. The probe then touches no file, socket or `PATH` entry and reports `unknown` with the reason `disabled`, which the stack report shows as `disabled` (reason "Realm probe switched off by ULTRATHINK_REALM=off", fix "unset ULTRATHINK_REALM"). This opt-out is the only switch; there is no new setting.

## What ultrathink reads

| What | Where | Bound | Used for |
|---|---|---|---|
| Realm config | `$XDG_CONFIG_HOME/realm/config.json` when `XDG_CONFIG_HOME` is an absolute path, otherwise `$HOME/.config/realm/config.json` | 64 KiB | the `stateDir` field only |
| Control socket | `<stateDir>/run/control.sock` | one NDJSON `status` exchange; 1.5 s for the whole probe | the state, label, mode, reason and last transition time |
| Session records | `<stateDir>/sessions/*.json` | at most 16 files, 64 KiB each | the `workspaceRoot` values, to tell whether the current directory is a Realm workspace; `unknown` when none can be read |
| `realm status` | the `realm` binary on `PATH` | killed at the remaining 1.5 s budget | a fallback, used only when no socket path can be derived |

The config path rule is Realm's own: a relative `XDG_CONFIG_HOME` is ignored, and when neither base is absolute there is no config to read.

Only `stateDir` is taken from the config. `image`, `andaUrl` and every other field are never read into the report and never logged. Session files contribute `workspaceRoot` strings and nothing else. No reason text, probe field or log line carries a config value other than the state directory path.

The probe never throws. The `realm status` fallback is the only process it can start; it runs only the `status` subcommand, and it accepts either a JSON status or the literal `disconnected`, which Realm's CLI prints when no daemon answers.

### Socket trust rule

Nothing is sent to a socket until the whole rule holds:

1. The socket path is absolute.
2. `lstat` (never `stat`) shows a socket, owned by the current user, at mode 0600.
3. Its run directory (`<stateDir>/run`) is owned by the current user at mode 0700.

If any part fails, the result is `unknown` with the reason `untrusted-socket` and zero bytes are written. The rule matches what Realm itself sets up: the run directory at 0700, and the socket chmod 0600 after listen. Realm refuses to serve from a run directory that is not exactly 0700 and owned by the current user.

Once trusted, the probe connects, writes one line `{"id":1,"method":"status"}`, reads one NDJSON line and closes. It checks the reply field by field in the way Realm's own client does: `state` is one of the six states (`unbound`, `connecting`, `active`, `degraded`, `error`, `stopping`), `display.label` is one of the two labels (`realm active`, `realm disconnected`), `mode` is `advisory` or `fail-closed`, and `lastTransitionAt` is a string. Any mismatch, a malformed line, or a reply that does not arrive in time gives `unknown` with the reason `schema` or `timeout`.

## The report

Each probe outcome maps to one stack connection.

| Probe outcome | Stack connection | Reason shown | Notes |
|---|---|---|---|
| No config and no socket | `disabled` | Realm not installed or not configured | Realm is optional, so this is not a fault |
| Config present, no socket | `unavailable` | the daemon is down | the daemon is not running; ultrathink does not start it |
| `active`, mode `advisory` | `degraded` | Realm active, advisory mode: writes are not contained | affects `containment` |
| `active`, mode `fail-closed` | `connected` | Realm enforcing | see [Advisory mode](#advisory-mode-and-omp) for what this means under Omp |
| `degraded` state | `degraded` | `Realm degraded (<Realm's reason>)`, followed by "fail-closed blocks host writes" in fail-closed mode or "advisory mode, writes are not contained" in advisory mode | the label still reads `realm active`; `degraded` is a flag on that label, not a third label |
| `unbound`, `connecting`, `error`, `stopping` | `unavailable` | `Realm <state>: <reason>` | the reason is Realm's own reason text |
| `unknown` (`timeout`, `schema`, `io`, `untrusted-socket`) | `unavailable` | names the reason | nothing is assumed about Realm |
| `unknown` (`disabled`, from `ULTRATHINK_REALM=off`) | `disabled` | Realm probe switched off by `ULTRATHINK_REALM=off` | the fix shown is to unset the variable; nothing is read or sent |
| Config unparsable, over 64 KiB or without `stateDir` | `misconfigured` | the config cannot be read | used only when the config file exists |

The report also carries whether the current directory matches a Realm session workspace (`true`, `false` or `unknown`) and when the probe ran.

`realmHint` turns a probe into a short instruction for the agent and is pure: it reads nothing and sends nothing. It returns whether enforcement is `none`, `advisory` or `enforcing`, whether to route work through Realm, and the instruction text. Routing through Realm is advised only for hosts that Realm documents an MCP entry for (Claude Code, Grok Build, Hermes, Muse and Prime Agent) and only when Realm is active in fail-closed mode; whether Realm's MCP server is attached in that host is not verified, so the instruction says "if the realm server's tools are available". Omp is reached through Realm's extension, not an MCP entry, and Cursor has no documented Realm integration. Where the hint is injected is decided where the report is wired into planning, not here.

## Advisory mode and Omp

Advisory mode does not contain writes under Omp. This is Realm behavior that ultrathink reads and cannot change.

- Realm's Omp extension registers no tools. It guards the host `write` and `edit` tools with a `tool_call` hook, and it lets those calls through whenever the state is `active`. It never moves a write into the sandbox.
- Host `bash` is not guarded at all.
- In advisory mode the guard only warns when Realm is not active, and the write proceeds. In fail-closed mode it blocks `write` and `edit` while Realm is not active. In neither mode does an active Realm redirect a host write.
- The block holds only inside Omp's extension pipeline. Launch-time tool flags, SDK sessions, and a host that ignores the hook are not covered, and Realm's source says so.

So the report line "Realm enforcing" says Realm's policy mode is fail-closed. It does not say that an Omp session's `bash`, or its `write` and `edit` while Realm is active, run inside the sandbox. Containment under Omp needs work in Realm (request 5 below).

## Coexistence with Realm's Omp extension

The two extensions do not share hooks.

| Owner | Piece | Where |
|---|---|---|
| Realm | the `tool_call` guard on `write` and `edit` | Realm's Omp extension |
| Realm | the status item keyed `realm` | `ctx.ui.setStatus("realm", ...)` |
| Realm | the `/realm-retry` command | `pi.registerCommand("realm-retry", ...)` |
| ultrathink | the read-only probe and its report | `src/stack/realm.ts`, a stack connection |

ultrathink adds no blocker, no `tool_call` handler on `write` or `edit`, no status key `realm` and no retry command. Its hint tells the agent only this: if `write` or `edit` is refused with a `REALM_*` code, run `/realm-retry` or stop and report it, and do not work around the refusal with `bash`.

## Requests for Realm

These are requests, not changes made by ultrathink, and not promises by Realm.

### Request 1: Publish the status and ToolOutcome schemas

Publish the JSON schemas for the `status` reply and for `ToolOutcome`, so a sibling can validate against a published contract and not against Realm's source.

### Request 2: realm status --json with schemaVersion

Give `realm status` a `--json` form that carries a `schemaVersion`, so the wire shape can change without silently breaking readers.

### Request 3: Fix the MCP server version

`MCP_SERVER_VERSION` in `src/mcp/server.ts` is `0.0.0` while the package version is `0.1.2`. Make them agree.

### Request 4: Expose state.transition events

Expose `state.transition` events, so a reader can follow transitions without polling `status`.

### Request 5: Route Omp write and edit into the realm

Route Omp `write` and `edit` into the realm, or register `realm_*` tools in the Omp extension, so an active Realm contains writes under Omp (see [Advisory mode and Omp](#advisory-mode-and-omp)).

### Request 6: Document lane semantics and a REALM_SESSION_ID environment variable

Document the lane semantics, and provide a `REALM_SESSION_ID` environment variable.

### Request 7: Correct the error-code header count

The header of the error catalogue says 28 codes while the list holds 29. Correct whichever is wrong.

### Request 8: State whether degraded blocks writes

State whether the `degraded` state blocks writes while the label reads `realm active`, so a reader of the label alone is not misled.

## Live proof status

The live proof against a running Podman realm is not run. It needs Podman 5.x and depends on Realm's phase 9.6. Everything on this page is evidenced from Realm's source files or tested against a fake control socket; none of it was observed against a live daemon.
