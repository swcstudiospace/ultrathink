# Omp golden fixtures

Golden capture of the Omp host's registered `/ultrathink-*` commands, taken before any refactor of
`src/host/omp.ts`. A later extraction is checked by re-running the capture and requiring byte-identical output.
The baseline and its determinism result are in `.planning/research/omp-baseline.md`.

## Run

```sh
bun test/golden/omp/capture.ts              # writes fixtures/*.json
bun test/golden/omp/capture.ts --out DIR    # writes DIR/*.json (use for a comparison run)
```

Compare: `diff -r test/golden/omp/fixtures DIR` must print nothing. Any diff is a behavior change in Omp output
(or a normalization gap). Do not hide a diff: fix the code, or add a normalization rule and record why.

The script does not run the test suite, the type checker, or a formatter. It needs no network, no real Omp session,
and no credentials.

## What is captured

`capture.ts` calls the default export's factory, `createOmpExtension()`, against a mocked `ExtensionAPI` with the same
surface `src/host/omp-test.helpers.ts` records: `on`, `sendMessage`, `sendUserMessage`, `registerCommand`,
`registerMessageRenderer`. Each command handler is then invoked with a context whose `cwd` is a sandbox workspace and
whose session id is fixed. For each case it records:

- `input`: the command line, the raw args, the session id, the cwd (normalized).
- `output`: `notices` (every `ctx.ui.notify` text and level), `sentMessages` (every `pi.sendMessage` message and
  options), `userMessages` (every `pi.sendUserMessage` text), and `threw` if the handler threw.
- `sideEffects`: the sandbox tree diff, path-sorted, with `created`, `modified` or `deleted` and the file text.

One fixture per entry point, `fixtures/<entry>.json`, plus `fixtures/registration.json` (the registered command names,
descriptions and argument completions, the event names passed to `pi.on`, and the message renderer types).

Fixture shape:

```json
{ "schema": 1, "entry": "ultrathink-track", "source": "...", "capture": "test/golden/omp/capture.ts",
  "cases": [ { "name": "...", "input": {...}, "output": {...}, "sideEffects": [...] } ],
  "excluded": [ { "variant": "...", "reason": "..." } ] }
```

Entry points are the eight registrations in `src/host/omp.ts`: the six verbs from the `COMMANDS` table
(`quick`, `skip`, `off`, `on`, `track`, `status`), `ultrathink-ui`, and `ultrathink-swarm`.

## Sandbox and environment pinning

- Each entry point gets its own sandbox under a `mkdtemp` run root: `home/`, `workspace/`. Every host state dir
  (`PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `HERMES_HOME`,
  `PRIME_AGENT_CODING_AGENT_DIR`) points into that sandbox, and `HOME` points at its `home/`. So reads and writes
  of the operator's real config, Omp agent dir, or grok auth cannot happen.
- Secret-named environment variables (names matching `/TOKEN|KEY|SECRET|PASSWORD/i`) are set to the literal string
  `<REDACTED>` in the capture process before anything else runs. No real value is read into memory or written.
- Apart from those variables, the process environment is replaced with an allowlist: `PATH`, `TMPDIR`, plus pinned
  `TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`. Host configuration (`ULTRATHINK_*`, `SWARM_ROOT`, `GROK_PLUGIN_DATA`, and
  everything else) is dropped, so output cannot depend on the operator's shell. Secret-named variables are the one
  exception: they keep their names with the value `<REDACTED>`, so the code under test sees them as set. Their names
  are host-specific, so the number of them present at capture time is recorded in the baseline. A run on a host with a
  different set of secret-named variables is not comparable without re-capturing.
- The dynamic `import()` of `omp.ts` happens after pinning. A static import would evaluate its whole import graph
  before the pinned environment exists, so a module-level `process.env` read in that graph would see the host environment.

## Normalization (applied to every string and key, before saving)

Applied in this order per case; placeholders are numbered per case, so a case is self-contained.

1. Sandbox root (raw and real path) → `<ROOT>`.
2. UUIDs → `<ID-n>`, numbered by first appearance.
3. Hex runs of 16 or more characters → `<ID-n>`, numbered by first appearance.
4. ISO dates and date-times (`YYYY-MM-DD`, optionally with a time and zone) → `<TS>`.
5. Clock times `HH:MM:SS(.fff)` → `<TS>`.
6. Epoch seconds or milliseconds as digit runs (`1[67]\d{8}` or `1[67]\d{8}\d{3}`) → `<TS>`.
7. Numeric epoch values in JSON (integers in 1.6e9–1.9e9 seconds or 1.6e12–1.9e12 ms) → `<TS>`.
8. Object keys are emitted in sorted order.
9. Side-effect manifest entries are sorted by normalized path, then by content, so two files that normalize to one name keep a fixed order.
10. The repo checkout path (the directory above `test/golden/omp`) → `<REPO>`. Used for launch paths into the checkout.
11. Teach inbox file names `<epoch ms>-<8 random hex>.json`: the random part → `<RAND>` (the epoch is `<TS>` by rule 6).

Binary files and files over 64 KiB are recorded as `<binary, N bytes>`, not hashed. The manifest records content
after normalization, so it is stable across runs.

Non-normalized data that is deterministic within a run is kept verbatim (paths relative to the sandbox, command
text, counts, config-derived lines).

## Excluded (not captured live)

Recorded in each fixture's `excluded` array, with reasons:

- `ultrathink-status`: the SuperGrok OAuth logged-in line. Requires a real `auth.json` under the operator's home.
- `ultrathink-ui`: the TUI panel mount (`ctx.mode === "tui"` with `ui.custom`). Requires an interactive session.
- `ultrathink-swarm`: spawning lanes with a configured swarm root. Requires detached AgentSwarm lane processes.
- `ultrathink-swarm`: stopping a running lane. Requires a live lane process.

All four are `requires live host`.

## Hook handlers (`pi.on`)

`hook-*.json` fixtures cover the handlers the host registers with `pi.on`, driven through the same mocked ExtensionAPI.
For each handler the case records the event payload, the context fields it reads (cwd, session id), its `ctx.ui.notify`
calls, `pi.sendMessage` and `pi.sendUserMessage` calls, any `teach observe` launch, and the sandbox side-effect manifest.
A `command:<name>` step runs a registered command on the same host as a probe, so a later hook shows what the command left
in memory. Each case gets its own sandbox and its own extension.

Fixture shape: `"kind": "hook"`, `entry` (the event, or the observed events), and per case `input.setup` (plain data the
case seeded), `input.steps` (event, args, session id, cwd), `output.steps[].handlers[]` (one entry per registered handler,
in registration order; `handler` is its index, or `command`), and `sideEffects`.

| Fixture | Event(s) | Handlers |
| --- | --- | --- |
| `hook-session-start.json` | `session_start` | 1 |
| `hook-session-switch.json` | `session_switch` | 1 |
| `hook-session-shutdown.json` | `session_shutdown` | 1 |
| `hook-observe.json` | `agent_start`, `turn_end`, `tool_execution_start`, `tool_execution_end` | 1 each |
| `hook-turn-start.json` | `turn_start` | 1 |
| `hook-tool-result.json` | `tool_result` | 2 (0: edit attribution; 1: PR-sync nudge) |
| `hook-agent-end.json` | `agent_end` | 2 (0: observer; 1: teach observe handoff, then ship nudge) |

The setup the hooks read is real local state: git repositories with `origin` remotes (`refs/remotes/origin/main` is set
locally and the remote is never contacted), a session record in the state dir the host resolves for the case cwd (the
planner is not run), and a user `ultrathink.json` under the pinned `CLAUDE_CONFIG_DIR`. Git identity and dates are pinned.

`teach observe` is launched through the real `spawnObserveDetached`. Only its process launch is replaced by a recorder that
returns `pid: 0` and starts nothing; the recorded command, arguments and `ULTRATHINK_*` environment are the production values.

Each hook fixture's `excluded` array lists the handler behaviour that needs a live host (TUI mount, planner flight, network).

## Changing this capture

Adding a case: append to `SPECS` in `capture.ts`, regenerate, and review the diff. Changing a normalization rule:
edit `Normalizer` and re-run twice to confirm determinism. Do not edit fixture JSON by hand.
