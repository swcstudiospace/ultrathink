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
9. Side-effect manifest entries are sorted by path. Arrays of notices and sent messages keep their emission order,
   which is the observable behavior.

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

## Changing this capture

Adding a case: append to `SPECS` in `capture.ts`, regenerate, and review the diff. Changing a normalization rule:
edit `Normalizer` and re-run twice to confirm determinism. Do not edit fixture JSON by hand.
