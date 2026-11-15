# Prime-Agent minimum version validation

Date: 2026-11-15
Host: prime-agent. Current floor: `0.10.2` (`adapters/version-floor.ts:17`).
Checkout: `origin/main` (worktree `docs/min-version-prime-agent`), files copied to an isolated tree for the run. No commit.

## Result

**Validated minimum: `0.3.1`.** It is the lowest passing tested release. Its invoke (step 5) ran on a local stub provider, so this is not a live-model result. Its immediate predecessor `0.3.0` was tested and fails at the install step.

Versions below `0.3.1` tested so far: `0.3.0`, `0.2.0`, `0.2.1`, `0.1.1`, `0.1.0` all fail at `package install`, with `Error: Unknown option: --local` (exit 1). The `package` subcommand and `--local` flag are not present in those releases.

The floor `0.10.2` passes. The tested passing releases are exactly: `0.10.2`, `0.10.1`, `0.10.0`, `0.9.8`, `0.9.7`, `0.9.6`, `0.9.5`, `0.9.4` (postinstall not run), `0.9.3`, `0.9.0`, `0.8.1`, `0.7.1`, `0.6.1`, `0.5.1`, `0.4.0`, `0.3.1`. No other release is claimed to pass; releases not listed here are failed, untested, or have no artifact (see the table and Not tested). The floor is well above the validated minimum. Floor values were not changed.

## Lifecycle (per release)

1. `prime-agent package list` (expect `No packages installed.`)
2. `prime-agent package install <stage> --local`, where `<stage>/package.json` has `"pi":{"skills":[<clone>/hosts/prime-agent, <clone>/skills/*]}`
3. `prime-agent package list` (expect `Project packages:`)
4. Load: `prime-agent --mode rpc --cwd <project> --no-session`, then stdin `{"id":"1","type":"get_commands"}`. Expect `skill:ultrathink`.
5. Invoke: `prime-agent -p --no-session --cwd <project> --provider ut-mock --model ut-mock-model -- "/skill:ultrathink" "/ultrathink-status"`
6. `prime-agent package remove <stage> --local`
7. `prime-agent package list` (expect `No packages installed.`)

Each release ran with its own `HOME`, `XDG_*`, and `PRIME_AGENT_CODING_AGENT_DIR`, with `PRIME_AGENT_TELEMETRY=0` and `DO_NOT_TRACK=1`.

Invoke provider: a local OpenAI-compatible stub at `127.0.0.1:18765`, configured in the isolated `models.json` as provider `ut-mock` (`apiKey` is a dummy string). **No Claude or other login was copied or used, and no credential values were read or written.** The stub confirms the request reached it and contained the skill text, and returns `MOCK-OK`. It does not show a real model's behaviour.

Caveat: the stub can mask a missing subcommand. In `0.3.0` the CLI treats `package list` as a prompt, so the stub returned `MOCK-OK` for step 3. Pass criteria therefore require real package-manager output (`No packages installed.` / `Project packages:`) in steps 1, 3, and 7. Every passing release below meets that.

## Tested versions (exit status of each step; 1 = failure)

Source column: `bin` = standalone release tarball from `pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/vX/`, SHA256 matched `SHA256SUMS`. `npm` = npm tarball `prime-agent-X.tgz` from the same bucket, installed into an isolated prefix (`npm install --prefix`, SHA256 matched). Releases `0.9.0`–`0.9.8` are TypeScript builds; `0.10.0`+ are Rust builds.

| Version | Source | 1 list | 2 install | 3 list | 4 load (skill listed) | 5 invoke | 6 remove | 7 list | Result |
|---|---|---|---|---|---|---|---|---|---|
| 0.10.2 (floor control) | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass (stderr warning: `agent_message` Python skill unavailable) |
| 0.10.1 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass (same warning) |
| 0.10.0 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.8 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.7 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.6 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.5 | bin | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.4 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass (postinstall not run: npm 11 approval gate) |
| 0.9.3 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.9.0 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.8.1 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.7.1 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.6.1 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.5.1 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| 0.4.0 | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | Pass |
| **0.3.1** | npm | 0 | 0 | 0 | 0, yes | 0, `MOCK-OK` | 0 | 0 | **Pass (validated minimum)** |
| 0.3.0 | npm | 0 | **1** (`Unknown option: --local`) | 0 (stub reply) | 0, no skill | 0 (stub reply) | **1** | 0 | **Fail** |
| 0.2.1 | npm | 0 | **1** (`Unknown option: --local`) | 0 | 0, no skill | **1** (`Unknown option: --`) | 1 | 0 | Fail |
| 0.2.0 | npm | 0 | **1** (`Unknown option: --local`) | 0 | 0, no skill | **1** (`Unknown option: --`) | 1 | 0 | Fail |
| 0.1.1 | npm | 0 | **1** (`Unknown option: --local`) | 0 | 0, no skill | **1** (`Unknown option: --`) | 1 | 0 | Fail |
| 0.1.0 | npm | 0 | **1** (`Unknown option: --`) | 0 | 0, no skill | **1** (`Unknown option: --`) | 1 | 0 | Fail |

Output checks: steps 1 and 7 show `No packages installed.` and step 3 shows `Project packages:` for every passing release (verified from the saved step logs). For the failing releases, `package install` or `package list` did not produce package output.

Note on `0.3.0`: step 5 exit 0 and `MOCK-OK` are stub artifacts, not evidence of a passing invoke. The install failure (step 2) already makes it a failure.

## Not tested

- Releases with no standalone or npm artifact in the bucket: `0.8.2`–`0.8.9` (404), `0.9.9` (404), `0.4.1` (404), `0.6.5`, `0.7.5`, `0.7.9` (404).
- Released but not run: `0.9.1`, `0.9.2`, `0.8.0`, `0.7.0`, `0.6.0`, `0.5.0`, `0.3.x` beyond `0.3.0`/`0.3.1`, and `0.10.3` (stable) and `0.10.4-beta.12` (beta). Not run because the minimum is already fixed by the `0.3.0` failure below `0.3.1`.
- Live-model invoke (real provider login). Not run (see the stub note).
- User-configuration install (no `--local`). Not run.

## Environment problems hit during the run

- Host root filesystem reached 100% full twice. Four npm installs (`0.4.0`, `0.3.0`, `0.2.1`, `0.1.0`) first failed with `ENOSPC`. They were retried after the run freed space, and the results above are from those retries.
- An early run's daemon (`daemon-catalog-entry.js`) was still alive after I killed the run. It owned the shared socket `/tmp/prime-agent-0/daemon.sock`, which is not isolated by `HOME`. I stopped that process and removed only the `daemon.sock` and `daemon.sock.lock` it created. Other entries in `/tmp/prime-agent-0` predate this run and were left unchanged.
- Earlier, while setting up the run, I accidentally used a 0.10.1 lifecycle pass without the stub provider. RPC then exited 1 with `No authenticated models`, while 0.10.0 listed skills without a provider. Not part of the table above.

## Cleanup

- Stub server (pid 290792) stopped.
- Isolated tree `/tmp/ut-min-prime-agent` removed (homes, npm prefixes, release binaries, logs). No credentials were copied, so there are none to delete.
- The real `~/.prime`, `~/.local/share/prime-agent`, and `/root/.claude` were not written by this run (no stub references found there).
- No files were changed in the checkout except this new file. Nothing was committed.
