# Troubleshooting

ultrathink fails open. When something is wrong, your prompt still goes through, with less planning or none. So most problems look like "the plan didn't appear" or "the rows didn't appear". Start with the [first checks](#first-checks), then look up the symptom or the host.

In the commands below, `<clone>` is the absolute path of your checkout. Paths written as `${NAME:-default}` use the environment variable when you set it, and the default otherwise.

- [Start with `ultrathink doctor`](#start-with-ultrathink-doctor)
- [First checks](#first-checks)
- By symptom: [Nothing happens](#nothing-happens) · [My control command printed nothing](#my-control-command-printed-nothing) · [Every plan shows fallback](#every-plan-shows-fallback) · [Planning degraded](#planning-degraded) · [bun not found](#bun-not-found) · [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured) · [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) · [Under load](#under-load) · [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) · [Tracking rows don't appear](#tracking-rows-dont-appear) · [Linear rate limit](#linear-rate-limit) · [Notion OAuth over SSH](#notion-oauth-over-ssh) · [Ship is blocked](#ship-is-blocked) · [Greptile knowledge base](#greptile-knowledge-base) · [Decisions](#decisions) · [Hindsight](#hindsight) · [RAGFlow](#ragflow) · [Teachable Moments](#teachable-moments) · [Redaction](#redaction)
- By USSR Stack link: [Stack](#stack) · [Environment](#environment) · [Hosted service](#hosted-service) · [Substrate brief](#substrate-brief) · [Swarm lanes](#swarm-lanes) · [Realm](#realm) · [Credential store](#credential-store)
- By host: [Claude Code](#claude-code) · [Grok Build](#grok-build) · [Muse Code](#muse-code) · [Hermes Agent](#hermes-agent) · [Omp](#omp)
- [Uninstalling](#uninstalling)

## Start with `ultrathink doctor`

`<clone>/bin/ultrathink doctor` checks your config files, the credentials your enabled features need, the state directory and the tools ultrathink runs on, without sending anything over the network. It names a misspelled key such as `ship.autoMerg`, a value the config merge ignores or adjusts, a missing credential and state files that other users can read. Run it from the project that has the problem, then come back here for anything it does not explain. See [Diagnose with doctor](how-to/diagnose-with-doctor.md).

## First checks

`bin/ultrathink status` (or `/ultrathink-status` inside the agent) prints the full state for one host. On a fresh install it looks like this:

```text
Prompt Uplift on
Engine: claude:claude-haiku-5-5
Claude: claude-haiku-5-5 · auth plan · fallback to Grok off
Grok: grok-build-0.1 · transport http
SuperGrok OAuth: not logged in (run grok login)
Graph of Thought on
HITL clarifications on · max 4
Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
Notion: not configured
Linear team: not configured
Substrate: off (optional: set substrate.url or SUBSTRATE_URL)
Ship: off (opt-in: set ship.enabled)
Knowledge base: off (opt-in: set hitl.knowledgeBase)
Decisions: on · no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or ULTRATHINK_OPENROUTER_KEY)
Hindsight: off (opt-in: set hindsight.enabled)
RAGFlow: off (opt-in: set ragflow.enabled)
Teach: on · capture auto · recall on · 0 confirmed, 0 candidate · Hindsight off · outbox 0
Engine request: auto (config) · concurrency 3
State: ~/.claude/ultrathink
```

From a plain terminal it reports on Claude Code. Set `ULTRATHINK_HOST` to check another host: `ULTRATHINK_HOST=grok-build`, `hermes`, `muse` or `omp`.

What the less obvious lines mean:

| Line | Meaning |
|---|---|
| `Grok: …` | The Grok engine's settings. They matter only when `Engine:` shows a Grok model. |
| `SuperGrok OAuth: …` | Whether the Grok Build CLI is logged in: ultrathink reads the session that `grok login` saved in `auth.json` in the Grok home (`grok.home`, else `$GROK_HOME`, else `~/.grok`), and asks the `grok` CLI to refresh it when it has expired. It matters only when the engine is Grok with the `http` or `cli` transport. When the engine is Claude or Muse, `not logged in (run grok login)` is expected and harmless. With `transport shunt` the line reads `not used (shunt gateway owns upstream auth)`. |
| `Tracking: …`, `Notion: …`, `Linear team: …` | See [Tracking rows don't appear](#tracking-rows-dont-appear). |
| `Substrate: …` | The optional Agent Substrate brief. It is off unless you set `substrate.url` or `SUBSTRATE_URL`; `SUBSTRATE_DISABLED=1` turns it off again. |
| `Ship: …` | The PR, review and merge loop. Off unless you set `ship.enabled`; `ULTRATHINK_SHIP=0` turns it off for that shell. When on, it shows whether `autoMerge` and `deleteBranch` are on. |
| `Knowledge base: …` | The Greptile knowledge-base read before the clarifying questions. Off unless you set `hitl.knowledgeBase`. See [Greptile knowledge base](#greptile-knowledge-base). |
| `Decisions: …` | Jev decisions over OpenRouter or Vercel. Jev is always on; `Decisions: off (ULTRATHINK_DECISIONS=0)` shows whenever that variable is set, whatever the config says. When on, it shows the model, the active points, the rail (`provider vercel` or `provider openrouter`), where the key came from (`key from store`, `key from AI_GATEWAY_API_KEY` or `key from ULTRATHINK_OPENROUTER_KEY`, never the key) and whether zero data retention is requested, or `Decisions: on · no Jev key (…)` when there is no key for the resolved rail. On the OpenRouter rail, a trailing ` · url <url>` means `ULTRATHINK_DECISIONS_URL` is in effect; a trailing ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` means it is set but not accepted. See [Decisions](#decisions). |
| `Hindsight: …` | The optional memory server. `Hindsight: off (opt-in: set hindsight.enabled)` until a user file sets `hindsight.enabled`, and `Hindsight: off (ULTRATHINK_HINDSIGHT=0)` whenever that variable is the exact string `0`. A missing key names the command to run: `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)`. See [Hindsight](#hindsight). |
| `RAGFlow: …` | Optional document search. `RAGFlow: off (opt-in: set ragflow.enabled)` until you opt in, and `RAGFlow: off (ULTRATHINK_RAGFLOW=0)` when that variable is `0`. A missing key names `bin/ultrathink-mcp auth set-key ragflow --stdin`. See [RAGFlow](#ragflow). |
| `Teach: …` | Teachable Moments. On by default (`capture auto`, auto-promote); `Teach: off (opt-in: set teach.enabled)` only when a user file turned it off. State is under the host state directory's `teach/`, never `<cwd>/.planning`. See [Teachable Moments](#teachable-moments). |

After each planned prompt, hosts that show the summary (`claude.echo`, on by default) print one line such as `Prompt Uplift · UPLIFTED_PROMPT · llm · claude:claude-haiku-5-5 [route default] · reason route-default-model · engine auto (config) · Graph of Thought · 6 nodes · Tracking · 6 issues · 18 sub-issues linked · 41.2s`. The part after the source names the planning model, why it was chosen and the engine request (see [Planning model states](how-to/choose-engine.md#planning-model-states)). A `fallback` source means the engine call failed, and an `Engine error · …` segment shows the first error. A `Failover · claude:claude-haiku-5-5 → grok:grok-build-0.1 (plan-limit)` segment means one candidate failed and the next one answered: the plan is complete. With Jev decisions on, a `Decisions · …` segment shows what Jev decided, for example `Decisions · plan 0.97` or `Decisions · error (credits)`.

## Nothing happens

No summary, no plan, and the agent answers the raw prompt.

1. **Check the state.** Run `bin/ultrathink status` for the right host. `Prompt Uplift off` means planning was turned off; `/ultrathink-on` turns it back on. `(skipping next prompt)` means a skip is armed.
2. **Check that the prompt is one ultrathink plans.** Trivial acknowledgements (`ok`, `lgtm`, …), built-in slash commands, `raw:` prompts, subagent sessions and ultrathink's own skills are skipped on purpose. These deterministic skips are decided before an engine is selected, on every host, so they never start the engine or show a login notice. `bin/ultrathink status` shows the last one as `last skip: <reason> <age>`. See [Commands](commands.md#prompt-prefixes-and-automatic-skips). `uplift: <prompt>` forces planning. With Jev decisions on, a message Jev judged is not new multi-step work is not planned either; with `claude.echo` on you see `Prompt Uplift · not planned: Jev judged this is not new multi-step work (<P>) · start with uplift: to plan it`. See [Decisions](#decisions).
3. **Check the environment.** `ULTRATHINK_UPLIFT=0` in the host's environment turns planning off for the whole process.
4. **Check the engine.** With `Engine: grok…` and `SuperGrok OAuth: not logged in` or `expired`, every prompt that would be planned is skipped with ``Prompt Uplift skipped · Grok login required (run `grok login`)``, on Grok Build under `auto` as well (a prompt the deterministic skips of step 2 already drop never reaches the login check). Run `grok login`, or switch back with `bin/ultrathink grok engine claude`. Claude replaces a selected Grok route only through the two explicit, labeled user switches: `grok.fallbackToClaude: true` (HTTP/CLI login missing or expired) and `grok.enabled: false` (documented ‘forces Claude even when Grok is selected’). Without them, a missing or expired Grok login skips planning with the unchanged `GROK_LOGIN_REQUIRED` notice. Naming `think.engine: "claude"` is a deliberate engine choice, not a replacement. With the `shunt` transport, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured). A notice that ends in `unresolved [<reason>]` means no planning model could be used; see [Planning model states](how-to/choose-engine.md#planning-model-states). If the summary shows `fallback`, the engine call failed. The Claude engine runs `claude -p`, so the `claude` binary (`claude.bin`) must be on the host's `PATH` and signed in with a plan login, on every host that uses it; likewise the `muse` binary (`muse.bin`) for the Muse engine.
5. **Check Bun.** A hook that can't find Bun lets the prompt through without a word to the agent. See [bun not found](#bun-not-found).
6. **Run the hook by hand with debug logging.** On Claude Code, Grok and Muse the prompt hook is `hooks/uplift.ts`. Every skip writes one `[ultrathink] skipped: <reason>` line to stderr whatever the debug setting, a skipped graph hand-off or already-uplifted spec also prints a one-line status note, and `ultrathink status` shows `last skip: <reason> <age>`. `ULTRATHINK_DEBUG=1` adds the failures:

   ```sh
   cd <your project>
   printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_DEBUG=1 ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/uplift.ts
   ```

   Lines such as `[ultrathink] skipped: slash-command`, `[ultrathink] uplift failed: …` or `[ultrathink] tracking failed: …` name the cause. Stdout is the JSON the host would receive. `ULTRATHINK_TRACK=0` keeps the test from creating rows. The run does call the engine, and it writes a `debug` session into the Claude Code state directory.

   Hermes uses `hooks/engine.ts`, whose JSON response has a `skipped` field with the reason (`child-or-disabled`, `parent-session`, `cron`, `empty`, `subagent`, `ultrathink-command`, `slash-command`, `ultrathink-skill`, `skill-preamble` (Hermes: a skill loaded with no task), `precheck-<reason>` with the same reason the Claude hook logs (`precheck-trivial`, `precheck-command`, `precheck-already-uplifted`, `precheck-graph-reference`, `precheck-skip-once` for an armed skip, `precheck-disabled` for planning off, `precheck-empty`, `precheck-extension`, `precheck-steer`, `precheck-passthrough` for a `raw:` prompt), `jev-skip` (Jev judged the message is not new work; see [Decisions](#decisions)), `uplift-failed`, `engine-error`, `aborted` (the planning run was cancelled), the Grok login message, or the reason of an `unresolved` model selection such as `transport-incompatible` or `unsupported-host`, which the response's `modelResolution` explains):

   ```sh
   printf '%s' '{"host":"hermes","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/engine.ts
   ```

   Omp no longer plans through `hooks/engine.ts`: it plans inside the Omp session, so the same command with `"host":"omp"` only answers `skipped: "native-unavailable"`. On Omp, check `/ultrathink-status` and the status bar instead (see [Omp](#omp)).

7. **Check the host wiring.** See the host sections below. Grok needs the global hook file, Muse needs approved hooks, Hermes needs the plugin to load and a hook cap of at least 105 s, and Omp needs the link.

## My control command printed nothing

Control commands (`/ultrathink-status`, `-off`, `-on`, `-skip`, `-track`) are answered by the prompt hook, which blocks the prompt so that no model turn runs. How the reply shows up depends on the host and on whether you run it interactively or headless:

| Host | Interactive | Headless |
|---|---|---|
| Claude Code | The reply is shown in the session. | `claude -p` prints `UserPromptSubmit operation blocked by hook:` followed by the reply. |
| Grok Build | The reply is shown in the UI. | `grok -p` prints nothing for a blocked command. |
| Muse Code | The reply is shown in the UI. | `muse exec` ends the run as `Cancelled`. |
| Omp | The reply is an Omp notification. | `omp -p` shows no notifications, and it exits before a `/ultrathink-quick` message runs. |
| Hermes Agent | The command dispatcher replies inline. | Same. |

The command still took effect when nothing was printed. Check with `bin/ultrathink status` (with `ULTRATHINK_HOST` set for that host), or run the command in the interactive UI. To change state from a script, call `bin/ultrathink <verb>` directly instead of sending a slash command through a headless run.

## Every plan shows fallback

Every summary line shows `fallback` as the source (often with an `Engine error · …` segment), and no rows are created. The plan context also carries a `## Planning degraded` block naming the engine and the error, and the session record keeps it as `engineError`.

- **Claude engine: update the `claude` CLI.** The Claude engine runs `claude -p` with `--tools ""`, `--strict-mcp-config` and `--exclude-dynamic-system-prompt-sections`. A CLI too old to know these flags fails every call, so every plan falls back. Claude Code 2.1.278 is the tested version for those flags, and the default model `claude-haiku-5-5` needs 2.1.293 or newer; update, and check that `claude.bin` (default `claude`) is the binary on the host's `PATH` and that it has a plan login.
- **Grok engine:** check the login (`SuperGrok OAuth:` in `bin/ultrathink status`) or, for `shunt`, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured).
- **Muse engine:** it runs `muse exec` with `--reasoning-effort` from `muse.reasoningEffort` (`high` by default; `xhigh` or `ultra` thinks longer). If the summary shows `fallback` with a `claude:…` model label (not `muse:…`), check the selected engine (`Engine:` line in `bin/ultrathink status`) and the `Engine error · …` segment first: an explicitly selected Claude engine whose CLI fails looks exactly the same. Only when the Muse engine is selected — or `auto` on the muse host — does that symptom mean the installed plugin predates the Muse engine: refresh it as in [Muse Code](#muse-code).

Engine error texts that name a cause:

| Error text | Meaning | What to do |
|---|---|---|
| `Credit balance is too low` | An `ANTHROPIC_API_KEY` in the environment shadows the plan login. Plan mode (`claude.auth: "plan"`, the default) ignores that variable for ultrathink's own calls, but an interactive `claude` uses it and fails with this text. If ultrathink shows it, `claude.auth` is `"api-key"`. | Remove the variable from your shell profile or service unit, or set `claude.auth` back to `"plan"`. Check with `claude auth status --json`: it should report `authMethod: claude.ai`. |
| `You've hit your session limit` (also weekly, Opus, Sonnet or monthly spend limit) | The plan's usage limit. Plan-login `claude -p` draws from the 5-hour session and the weekly limit. The text names when it resets. | Wait for the reset, or set `claude.fallbackToGrok: true` in your user config so the Grok route plans meanwhile. See [Claude to Grok fallback](how-to/choose-engine.md#claude-to-grok-fallback). |
| `grok-build-0.1` fails with HTTP 429 and a request limit of `0`, or HTTP 403 `requires a Grok subscription`, or the CLI says `unknown model id` | The xAI account behind your Grok login is not entitled to `grok-build-0.1`. The Grok CLI's default login (`~/.grok`) may belong to another account than the one that holds Grok Build. | With the default empty `grok.fallbackModels` the Grok route reports the failure (`Engine error · …`). The fix is the right login, not a pricier model: run `bin/ultrathink grok login` as the account that holds Grok Build, then `bin/ultrathink grok check`. See [Grok Build login lane](how-to/choose-engine.md#grok-build-login-lane). To walk on to another model anyway, list it in `grok.fallbackModels` yourself. |
| `Claude Code ... does not support this model` | The `claude` CLI is older than the model needs: `claude-haiku-5-5` needs 2.1.293 or newer. | Run `claude update`. `bin/ultrathink doctor` reports the installed version in its `inference` section. |

A failover that ends in a plan is not an error. See [When the engine fails](how-to/choose-engine.md#when-the-engine-fails).

To see the error, run the hook by hand as in [Nothing happens](#nothing-happens), step 6.

## Planning degraded

The plan context starts with a `## Planning degraded` block, but the plan itself arrived. This is not the same as [Every plan shows fallback](#every-plan-shows-fallback): there, the whole spec is generic text. Here one or more stages fell back and the others are real. ultrathink never hides this: each fallback is named in the notice, recorded in the session record, marked in the spec and flagged in the views. The prompt itself was never blocked.

| The notice says | Marker in `degraded` | What failed | What to do |
|---|---|---|---|
| `The <engine> planning call failed (<cause>). The specification below is generic fallback text` | `uplift` (with `source: fallback` and `engineError`) | The uplift call failed after its three attempts. The spec is the conservative fallback and no tracker rows were created. | Fix the cause named in the parentheses (see the table in [Every plan shows fallback](#every-plan-shows-fallback)), then resend. |
| `This record was skipped by an older planner because the prompt was over a character limit this version no longer enforces` | `uplift`, reason `input_over_limit` | An older planner skipped uplift. This version sends a prompt of any length; `uplift.maxChars` is ignored. | Resend the prompt. Do not set a character cap. |
| `Planning produced no usable model output (an empty or invalid completion)` | `uplift`, reason `empty_reply`, `truncated_reply` (cut off before the closing tag) or `unparseable_reply` | The model answered, but not with a complete uplift: empty, a refusal, an error page, or a reply cut off before the closing tag. | Resend, narrow the prompt, or fix the engine. |
| `the graph structure … use fallback content` | `graph` | The graph call failed or returned too few nodes, so the generic 5-node graph was used. No tracker rows were created from it. | Resend after the load passes; treat the graph as unverified. |
| `the n2 fill (<cause>) use fallback content` | `fill:n2`, one token per node id | That node's fill still failed after its retries and the repair pass (or the repair was skipped because no fill succeeded): a provider error, or a reply that was not a closed rationale of 5 to 8 steps plus a closed conclusion (the cause then reads `node fill was not a closed rationale …`). The other nodes are real. | Treat that node as unverified and do its reasoning yourself. Resend after the load passes, or lower `claude.concurrency` if provider 429s caused it. |
| `Failed: the clarify step (<cause>) — the plan lacks their output` | `clarify` | The clarification call failed or its reply could not be read. Complete questions at the start of a cut-off reply are kept; otherwise there are none. | Ask yourself what the questions would have covered, or resend. |
| `Failed: the think step (<cause>) — the plan lacks their output` | `think` | An unexpected error ended the Graph of Thought stage. Whatever it had filled is kept; the rest is marked as above. | Resend; if it repeats, run `bin/ultrathink doctor`. |

Where to see it:

- **Plan output.** The `## Planning degraded` block in the context, and a stage detail in the progress and debug output such as `8 nodes · fill:n2, fill:n5`. The block also says whether tracker rows were created, are incomplete, or were not and will not be.
- **Session record.** `sessions/<id>.json` has a `degraded` array of the markers above, and `engineError` for the first engine error.
- **Spec XML.** A node whose fill failed carries `degraded="true"` on its `NODE` element and has no conclusion.
- **Wave views.** The graph view (`ultrathink_graph`) flags the node as a fallback, and lists the ids under `degraded.fills`.
- **Tracker rows.** Rows of a degraded node carry a `[degraded fill]` marker (the Linear title, the Notion `Item`, the descriptions and the `Thought` text). Rows are never created from the generic fallback graph.

What to do, in order: wait out a rate limit or an overloaded provider and resend; check the provider's status page and your plan's usage limits; narrow the prompt so the graph stays small; and run `bin/ultrathink doctor` for a credential or version problem. A cancelled flight (a newer prompt, `/ultrathink-quick`, a model switch) is not a degradation and shows no notice.

## bun not found

Hooks and CLIs start Bun through `bin/run-bun`, which looks for it in this order: `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `~/.local/share/*/bun/bin/bun`. If none of them exist, it prints this to stderr:

```text
ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun
```

- **From a hook** it then exits 0, so the prompt goes through unplanned and the host shows no error. The line only appears where the host shows hook stderr.
- **From a CLI** (`bin/ultrathink`, `bin/ultrathink-mcp`, `bin/ultrathink-ship`) it exits 127. A script that checks the exit status sees the failure.

Fix it by installing Bun 1.2 or newer in one of those places, or by setting `BUN` to the binary in the host's environment. On Hermes, a control command replies `Ultrathink <verb> failed: ultrathink: bun not found. Install Bun …`. The Hermes planner also honors `BUN`.

## Grok shunt gateway not configured

The Grok `shunt` transport sends planning calls to an Anthropic-compatible gateway that you run. ultrathink ships no gateway and has no default address. If `grok.transport` is `shunt` and `grok.shuntBaseUrl` is empty:

- `bin/ultrathink status` shows `shunt gateway not configured (set grok.shuntBaseUrl)` on the `Grok:` line.
- The prompt is not planned and nothing is sent. The hook reports ``Prompt Uplift skipped · grok:unresolved [transport-incompatible]``, and the agent gets the prompt as you typed it.

Set `grok.shuntBaseUrl` to your gateway's base URL (ultrathink appends `/v1/messages`), or set `grok.transport` back to `http`. See [Choose an engine](how-to/choose-engine.md) and [Configuration](configuration.md#grok-the-grok-engine).

## The plan is slow or cut off

A full plan makes several model calls (uplift, graph, one fill per node, clarifications) and then creates rows, so it can take minutes. Each host bounds it differently:

| Host | Bound | What happens at the bound |
|---|---|---|
| Claude Code | Hook timeout 86 400 s (`hooks/hooks.json`) | Not reached in practice. |
| Grok Build | 600 s `UserPromptSubmit` timeout in `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` | Grok stops the hook and the prompt goes through unplanned. |
| Muse Code | 600 s (`timeoutMs: 600000` in `.muse-plugin/plugin.json`) | Same. |
| Hermes Agent | Hermes' `plugins.hook_callback_timeout` minus 15 s, when that cap is positive and leaves at least 90 s (30 s by default; set the Hermes cap to 600). No positive host cap means the bridge waits until the engine exits | The planner kills Bun's process group at that deadline and no context is added. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives). |
| Cursor | No product timer. The hook waits until the engine exits and does not slice the spec | A missing Bun, a planner error, or a child or swarm session leaves the prompt unchanged. |
| Prime Agent | No product timer. The bridge waits until the engine exits and does not slice the spec | A planner failure leaves the prompt unplanned. |

To make plans faster, lower `think.maxNodes`, raise `claude.concurrency`, set `claude.budgetMs` to cap the whole run, or turn Graph of Thought (`bin/ultrathink think off`) or HITL (`bin/ultrathink hitl off`) off for a host. See [Configuration](configuration.md) and [Reduce cost and latency](how-to/reduce-cost-and-latency.md).

## Under load

Everything below describes a machine or a provider account that is busy: many agent sessions, builds and test runs at once, or a rate-limited provider. ultrathink is built to keep delivering real plans in that state, and to say so when it cannot. It does not add a default planning deadline to get there: a slow plan is a slow plan, and only the host's own hook timeout (see the table above) or a cancellation ends one.

| Symptom | Cause | Fix |
|---|---|---|
| Every plan is slow, hooks take several seconds before anything happens, and `uptime` shows a load average above your CPU count or the machine is swapping | CPU or memory pressure. Starting Bun, not the model, is what is slow. Nothing is dropped: children that ultrathink started are ended when their parent goes, and a hook writes its whole output before it exits. | Close other sessions and builds, or wait. Do not raise timeouts to compensate; with no default deadline there is nothing to raise on Omp. |
| Several nodes at once show `the nX fill (… HTTP 429 …) use fallback content`, or `Engine error` mentions a rate limit | A provider 429 storm, often from other sessions on the same account. Each fill call retries inside its completer (3 attempts), waiting at least the provider's `Retry-After` (capped at 120 s); a failure the completer already retried is not retried again at the fill layer (`think.fillRetries` covers replies that are not a real fill: a refusal, truncated markup, fewer than 5 steps); the flight's limiter halves the number of fills in flight and pauses them all for that `Retry-After`; then one repair pass re-fills the failed nodes, unless every fill failed (the provider is down: repeating the calls would only add load, and each cause says `repair skipped`). A retry never changes the model, route or effort. | Wait and resend. Lower `claude.concurrency` (default 3), raise `think.fillRetries` (default 2), or stagger sessions. ultrathink does not coordinate model calls across processes, so two sessions share the account's limit between them. |
| A toggle command fails with `lock … still held after 30000 ms` | Another process holds `control.json.lock`. Commands that are not hooks wait 30 s and then fail rather than write unlocked, so a toggle is never lost. A lock whose holder died is taken over at once; a live holder's lock is never taken. | Retry. If it persists, find the process that is stuck. Do not delete a lock held by a live process. |
| Debug output shows `lock … still held after 15000 ms, writing unlocked` (`2000 ms` in the Omp TUI) | A hook entrypoint waited 15 s for a lock (the Omp extension waits 2 s and says nothing in the TUI) and wrote without it, so as not to block the prompt. A concurrent update to that file can be lost. | Usually harmless. If it repeats, look for a wedged session. |
| `ultrathink_uplift` or `/ultrathink` is refused as `busy` with `retry after 30s` (hosted service) | All plan slots are taken and the wait queue (`maxConcurrentPlans x 4` starts, 60 s) is full, this caller already has half of it, or its 60 s wait ran out. | Retry after 30 s. Raise `ULTRATHINK_MAX_CONCURRENT_PLANS` only if the host can take it. |
| The hosted service answers `upstream_unavailable` with a retry hint | The failure-rate breaker is open: at least 5 failures (`ULTRATHINK_BREAKER_FAILURES`), at least `min(10, 5)` calls in the window and at least half of the calls failing. It admits one probe after `ULTRATHINK_BREAKER_OPEN_MS` (30 s). | Retry after the hint. Check the planning login and the provider's status. A plan that was already running ends `invalid` with `upstream refused` and keeps its answered fills. |
| `POST /ultrathink` answers `501 run_api_unavailable` | No worker executes queued runs yet; the service refuses instead of accepting work that would never start. | Use the MCP tools (`ultrathink_uplift`). |
| New plans are refused with `not_ready` | The hosted service is draining for a shutdown. | Retry against the restarted service. |
| A hosted plan never finishes | Both `ULTRATHINK_MODEL_TIMEOUT_MS` and `ULTRATHINK_PLAN_TIMEOUT_MS` are 0, so a hung model call is never stopped and keeps its plan slot. The service warned about this at start (`timeouts_unset`, `--check-config`, doctor `runtime.service-timeouts`). | Cancel it with `ultrathink_cancel` and its `sessionId`, which frees the slot, or set a timeout. |

To reproduce the check on your own machine, run the deterministic load harness, which needs no credentials and spends no tokens:

```sh
cd <clone> && bun run chaos -- pipeline run smoke
```

It sends 50 varied prompts through the real pipeline against a fault-injecting fake provider and prints a score and ten invariants. Add `--pressure` to run it while CPU workers load the machine. The pass criteria, the other scenarios and the recorded results are in the [Load runbook](ops/load-runbook.md).

## Hermes: the plan never arrives

Hermes stops waiting for a plugin hook after `plugins.hook_callback_timeout` seconds, 30 by default. This is a global Hermes setting that applies to every plugin, and nothing sets it for you: neither the plugin nor `scripts/setup.ts` changes it. A plan takes minutes, so the cap must be at least 105 s, and 600 is recommended.

A positive Hermes hook cap stops the engine 15 s before that cap, so children can be reaped. Below a 105 s cap that leaves under 90 s, too short for a plan, so the planner doesn't start Bun at all and returns at once. With no positive host cap the bridge waits until the engine exits. Hermes never waits long enough to time out when the cap is too short, so its log shows no hook timeout line, yet no prompt is planned. At the default 30 s cap, `${HERMES_HOME:-~/.hermes}/logs/agent.log` shows this once per Hermes process:

```text
ultrathink: Hermes hook cap 30.0s leaves under 90s to plan, so prompts go unplanned; run `hermes config set plugins.hook_callback_timeout 600`
```

Fix it and restart Hermes, including any running gateway:

```sh
hermes config set plugins.hook_callback_timeout 600
hermes config get plugins.hook_callback_timeout   # prints 600
```

600 is Hermes' maximum. Don't use 0, which turns off Hermes' hook deadline and makes the turn wait on the hook.

Every ultrathink warning in the Hermes log starts with `ultrathink:` and is logged once per process:

| Warning | Meaning | Fix |
|---|---|---|
| ``ultrathink: Hermes hook cap <n>s leaves under 90s to plan, so prompts go unplanned; run `hermes config set plugins.hook_callback_timeout 600` `` | The cap is below 105 s. | Raise the cap as above. |
| `ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses plugins.hook_callback_timeout = <n> from <path>/config.yaml; prompts are planned only when the cap is at least 105s (…)` | Your Hermes version doesn't tell plugins its cap, so the planner read it from the active profile's config, `${HERMES_HOME:-~/.hermes}/config.yaml` (or, when `active_profile` names a Hermes profile, `${HERMES_HOME:-~/.hermes}/profiles/<name>/config.yaml`). | Nothing, if `<n>` is 105 or more. Otherwise raise the cap. |
| `ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses Hermes' 30s default, as <path>/config.yaml sets no plugins.hook_callback_timeout; …` | The planner found no cap in the config, assumed 30 s, and never plans. | Set the cap as above. |
| `ultrathink: <path> not found; install hosts/hermes as a symlink into a full clone of ultrathink (docs/install.md#hermes-agent)` | The plugin directory was copied rather than symlinked, so `hooks/engine.ts` (or `bin/run-bun`) isn't beside it. Bun is never started. | Replace the copy with a symlink: `ln -sfn <clone>/hosts/hermes ${HERMES_HOME:-~/.hermes}/plugins/ultrathink`. See [Install](install.md#hermes-agent). |

If the cap is 600 and plans still don't arrive, the engine ran past that cap minus 15 s and its process group was killed. See [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) to make plans faster.

## Tracking rows don't appear

Check the tracking line of `bin/ultrathink status` first:

| Status line | Meaning | Fix |
|---|---|---|
| `Tracking: on (not configured: set notion.dataSourceUrl / linear.team)` | Neither tracker is configured, and none is by default. | Configure one: `bin/ultrathink-mcp notion init --parent <page> --write-config`, or set `linear.team`. See [Tracking](tracking.md). |
| `Tracking: off (Linear/Notion rows)` | `/ultrathink-track off` is set for this host. | `/ultrathink-track on`. |
| `Tracking: kickoff (planner-side row creation off; …)` | `ULTRATHINK_TRACK=0` or `track.enabled: false`. The planner creates nothing, and `ultrathink-kickoff` creates the rows during the agent's turn. | Expected. Unset it for planner-side rows. |
| `Tracking: on (Linear/Notion rows)` | Tracking should run. | Continue below. |

On Hermes the planner never creates rows, whatever the status line says. `ultrathink-kickoff` creates them at the start of the agent's turn with `ultrathink-mcp track complete --state <file>`, so check that the agent ran kickoff before anything else.

If tracking is on and configured:

- **Credentials.** `bin/ultrathink-mcp auth status` must show the configured provider as `ready`, and `bin/ultrathink-mcp check linear` (or `notion`) must print `OK <n> tools`. If no configured provider has credentials, tracking is skipped without a message. If one is logged in and the other isn't, tracking is `partial`, and `track complete` prints `! linear: login required` (or `! notion: login required`). For Linear, log in with `auth login linear` (OAuth) or store an API key from your Linear account settings with `auth set-key linear --stdin`. Notion takes `auth login notion` only.
- **Linear team.** `linear.team` must name a team in the workspace that the Linear credential belongs to.
- **Engine fallback.** A prompt whose summary says `fallback` is never tracked, so an engine outage doesn't fill your trackers with boilerplate.
- **Partial tracking.** Creation is bounded by `track.budgetMs` when it is set above 0 (the default 0 means no limit). The summary then says `Tracking · partial (N missing) · kickoff will finish`, and `ultrathink-kickoff` runs `track complete` in the agent's turn. To finish a session by hand:

  ```sh
  <clone>/bin/ultrathink-mcp track complete --state <state dir>/sessions/<id>.json
  ```

  It prints `tracking <status> · <n> issues · <n> sub-issues · graph <id>`, one `! <error>` line per failure, and the linked TODO lines. `tracking is off`, `tracking not configured` and `no tracker credentials` mean what they say.
- **Flat Notion rows.** If `notion init` reported that adding the `Parent Item` self-relation failed, rows are created but not nested. Add a two-way relation named `Parent Item` (synced as `Sub-Items`) from the database to itself in Notion.

## Linear rate limit

When Linear throttles the gateway, the error reads as a rate limit and not as an authentication failure:

```text
linear: FAIL mcp.linear.app rate limited; retry after 60s
```

Inside the planner it appears as a tracking error, and the tracking is `partial`. Wait for the retry delay, then let `ultrathink-kickoff` finish, or run `track complete` yourself. It creates only the missing rows. Lowering `track.concurrency` (default 6) reduces bursts of parallel creates. Don't log in again: the credentials are fine.

## Notion OAuth over SSH

`bin/ultrathink-mcp auth login notion` prints an authorization URL, then waits for the browser to come back to a callback on `127.0.0.1:8765` on the machine running the command. It also accepts the redirected URL pasted into the terminal. Over SSH the browser runs on another machine, where `127.0.0.1` is your own computer, so the callback can't reach the listener by itself. `auth login` detects an SSH session and prints the options. Pick one:

| Situation | What to do |
|---|---|
| You can forward a port (the default route) | Forward the port before opening the URL: `ssh -L 8765:127.0.0.1:8765 <user>@<host>`, or a local port forward in your SSH client (bind `127.0.0.1:8765` locally to `127.0.0.1:8765` through the host). |
| No forwarding possible | Approve in the browser, copy the full URL of the page you are redirected to (it may fail to load), and paste it into the terminal. `--no-listen` waits only for the pasted URL. |
| The host is on a Tailscale tailnet with HTTPS certificates | Opt in with `auth login notion --tailscale`, or set `ULTRATHINK_OAUTH_TAILSCALE=1`. Over SSH, `auth login` then adds a temporary `tailscale serve` handler at `https://<host's tailnet name>/ultrathink-oauth/callback` and removes it after login. Open the URL on any device in the same tailnet and the login finishes by itself. Without the opt-in, ultrathink never runs `tailscale`. With the opt-in but outside an SSH session, or when Tailscale isn't running or has no HTTPS certificate for the host, login quietly uses the loopback callback instead. Only a failing `tailscale serve` is reported, with a line saying the Tailscale route could not be set up. |
| Your own callback URL | `--redirect <url>` or `ULTRATHINK_OAUTH_REDIRECT=<url>`. It must be `https`, or `http` only for `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>`. `--port <n>` changes the port. |

If `auth status` later shows Notion as not ready, the grant was revoked or expired. Run `auth login notion` again. See also [Set up Notion](how-to/set-up-notion.md).

## Ship is blocked

Ship is opt-in: it does nothing until you set `ship.enabled: true`. `bin/ultrathink-ship` returns `ok: false` with a `reason`. A blocked review returns `blocked: true` and `next: "stop: <reason>"`, plus `status: "blocked"` when Greptile is unusable as configured; when a review or merge loop gives up it also posts a PR comment `ultrathink-ship stopped: <reason>` that lists the last attempts. `bin/ultrathink-ship status --state <stateFile>` then shows `phase: "blocked"`, the `blockedReason` and `attempts`, the log of every review result and merge outcome (newest 50). A blocked PR is left open for a human, and the skill doesn't retry. See [Ship](ship.md) for the flow and [Ship with Greptile](how-to/ship-with-greptile.md) for setup.

| Step | Reason | What to do |
|---|---|---|
| (no nudge) | The Stop or `agent_end` nudge never appears | The nudge needs `ship.enabled: true` (off by default), no `ULTRATHINK_SHIP=0`, a planned prompt that invoked a skill matching `ship.skills` (default `gsd-`), and local git on a feature branch with commits ahead of `origin/<default>`. It fires once per session. `bin/ultrathink status` shows the `Ship:` line. |
| `assess` | `done: false` with `gaps` | The task isn't finished. Finish the gaps and assess again. |
| `assess` | gap `no judge available` | With `autoMerge` on, the rule-only assessment can't pass. The engine must be available (see [Nothing happens](#nothing-happens)). A Jev answer never stands in for the engine judge here either, even with Jev decisions on for `ship`. |
| `assess` | gap `Jev judged the change incomplete (P(complete) <P>)` | Gate mode: the engine judge said done, but Jev's P(complete) was at or below `decisions.shipVetoAtOrBelow` (0.2) on an untruncated patch, so no PR is opened. Treat it like any not-done result: check the request and its acceptance criteria against the diff, finish the missing part and assess again. If Jev is wrong on your kind of change, see [Decisions](#decisions). |
| `assess` | gap `Jev P(complete) <P> is below <shipApproveAt>` | Gate mode with `ship.autoMerge` off and no usable engine verdict: Jev decided (`source: "jev"`) and its P(complete) was below `decisions.shipApproveAt` (0.7). Finish the work and assess again, or fix the engine so the judge can run (see [Nothing happens](#nothing-happens)). |
| `assess` | gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd` | The project has `.planning/ROADMAP.md` from GSD (the Get Shit Done planning workflow), but ship can't find GSD's `gsd-tools.cjs` to read it. It looks for `gsd-core/bin/gsd-tools.cjs` under, in order: the project, `<project>/.claude`, `<project>/.codex`; then `<project>/.claude/get-shit-done/bin/gsd-tools.cjs`; then `gsd-core/bin/gsd-tools.cjs` under `$CLAUDE_CONFIG_DIR` (if set), `~/.claude`, `~/.agents`, `${HERMES_HOME:-~/.hermes}`, `${CODEX_HOME:-~/.codex}`, `${GEMINI_CONFIG_DIR:-~/.gemini}`, `~/.cursor` and `${XDG_CONFIG_HOME:-~/.config}/opencode`; then for `~/.claude/get-shit-done/bin/gsd-tools.cjs`. Set `GSD_TOOLS=/path/to/gsd-tools.cjs`, or pass `--ignore-gsd` to assess without the roadmap. |
| `pr` | `task not assessed as done; run assess first` | Run `assess`. |
| `pr` | `no current branch (detached HEAD?)`, `on base branch <b>; work must be on a feature branch` | Move the work to a feature branch. |
| `pr` | `branch changed since assessment` | Run `assess` again. |
| `pr` | `uncommitted tracked changes: …` | Commit your own changes by explicit path, then retry. |
| `pr` | `could not determine default branch`, `push failed: …`, `create PR failed: …` | Check `gh auth status`, the `origin` remote and push rights. |
| `review` | `status: "blocked"`, ``Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)`` | No Greptile credential is stored, and the `greptile` CLI is missing or signed out. Ship checks this before the first review round, so no round is used up. Set up one of the two, then run `review` again. |
| `review` | `status: "blocked"`, `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json (one of: …)` | Greptile answered `tenant_required`: your account belongs to several organizations and none was chosen. Set `ship.greptileOrganization` to one of the listed ids or handles, then run `review` again. |
| `review` | `local HEAD <sha> differs from PR head <sha>; push your commits (or pull) first` | `git push`, then run `review` again. |
| `review` | `status: "pending"` | Not an error. Run `review` again; it resumes the same Greptile run. |
| `review` | `max rounds reached: …` | `ship.maxRounds` (5) completed reviews below 5/5 or with open threads. Failed and timed-out reviews don't count. A human takes over. |
| `review` | `Greptile review failed: <error>; run review again to re-trigger it (retry k of N)`, `Greptile review timed out; run review again to re-trigger it (retry k of N)` | Not a block. Greptile returned FAILED, ERROR or SKIPPED, no score, the CLI failed, or the review stayed pending past `ship.reviewTimeoutMs`. Run `review` again: it starts a fresh review of the same commit. Up to `ship.reviewRetries` (3) re-triggers per head commit. |
| `review` | `Greptile review failed N times on <sha> (ship.reviewRetries N): <error>`, `Greptile review timed out N times on <sha> (ship.reviewRetries N)` | Greptile failed or timed out more than `ship.reviewRetries` times on the same commit, so the ship is blocked and the PR comment lists the attempts. Check `greptile login` (CLI mode) or the Greptile credential (`bin/ultrathink-mcp auth status`), then run `review` again. |
| `merge` | `autoMerge disabled` | Expected by default: `ship.autoMerge` is off, so ship stops at a passing review and `run` reports `autoMerge disabled: merge manually`. Merge by hand, or set `ship.autoMerge: true`. |
| `merge` | `PR head changed since last review; run review again` | Run `review`. |
| `merge` | `review score N/5 is below 5/5; run review again` | Continue the review loop. |
| `review` or `merge` | `N open review comment(s)` | In PR mode these are the PR's Greptile review threads on GitHub that are neither resolved nor outdated. A fix that changes the flagged line makes its thread outdated. For a finding that isn't actionable (factually wrong, or describing intended behavior), reply on its thread with the reason and resolve it; the `review` output gives each finding's `threadId`, and [Ship](ship.md#fix-loop-and-blocking) has the commands. Never resolve a finding just to pass the gate. If the thread lookup fails (a `gh` error, a page that cannot be read, or more than 2,000 threads; threads are read 100 at a time), the gate fails closed and counts every unaddressed Greptile comment on the PR. Fix `gh auth status` and run `review` again. In CLI mode the count is the run's comments. |
| `review` or `merge` | `could not read review threads: <error>` | The PR's review threads couldn't be read from GitHub, so nothing is recorded and the merge is refused. `merge` keeps retrying this within its time (see `run merge again` below). Check `gh auth status`, then run `review` or `merge` again. |
| `merge` | `waiting: true`, `run merge again: <reason> (waited N of 60 min on this commit; it keeps retrying until the PR merges)` | Not an error. The review passed, but CI is pending, GitHub has not computed mergeability, the PR state or threads couldn't be read, GitHub returned a transient error, or branch protection refused with `the base branch policy prohibits the merge` (for example a required approval not given yet), and this call's `ship.waitMs` ran out. Run `merge` again; it keeps retrying the same commit for up to `ship.mergeTimeoutMs` (60 min), so a human can approve in the meantime. Past that it blocks with a PR comment. |
| `merge` | `merge conflicts: resolve them against the base, push, then run review again`, `CI checks failing: fix CI, commit, push, then run review again` | Back to the agent, never merged. Fix the cause, push, then run `review` again. |
| `merge` | `merge still not possible after N min on <sha>: <reason>` | The ship is blocked: the same reviewed commit could not merge within `ship.mergeTimeoutMs`. The PR comment lists the attempts. Fix the cause (for example stuck CI), then run `review` or `merge` again. |
| `merge` | `merge refused by GitHub: <error>` | The ship is blocked: GitHub refused for a reason retrying can't fix, such as missing permission, requested changes or a closed PR. A human acts (grant rights, resolve the requested changes or reopen), then runs `merge` again. |
| `merge` | `PR closed without merge` | The ship is marked blocked. |
| `merge` | `PR was merged outside the ship flow before its review passed` | The ship is blocked and not recorded as a ship merge: the PR was merged (by hand, web UI or another tool) without a passing Greptile review of its head. Review the merged change yourself. Agents must never merge any other way than `bin/ultrathink-ship merge`. |

Resume at any time with `bin/ultrathink-ship status --state <stateFile>`. Every step is idempotent.

## Greptile knowledge base

With `hitl.knowledgeBase: true` (see [Configuration](configuration.md#hitl-clarifying-questions) and [Use the Greptile knowledge base](how-to/use-greptile-knowledge-base.md)), the planner reads the repository's Greptile knowledge base before the clarifying questions. It fails open: whatever goes wrong, you get the same questions as with the key off. The summary after each plan shows what happened, and `bin/ultrathink status` shows the `Knowledge base:` line.

With `ULTRATHINK_DEBUG=1` (Claude Code, Grok Build and Muse), the prompt hook writes one line per lookup to stderr: `greptile knowledge base: <outcome>`, then the documents read or the reason, then the elapsed time, for example `[ultrathink] greptile knowledge base: error · timed out after 20000ms · 20004ms`.

| Symptom | Meaning | What to do |
|---|---|---|
| No `Knowledge` segment in the summary | The key is off, HITL is off (`Knowledge base: on · not read while HITL is off`), or the prompt was not clarified. | Set `hitl.knowledgeBase: true` and turn HITL on (`bin/ultrathink hitl on`). |
| `Knowledge · off (no Greptile login)` | No usable Greptile credential is stored, so Greptile was not contacted. `bin/ultrathink status` shows `Knowledge base: on · no Greptile credential (…)`. | Store one: `bin/ultrathink-mcp auth login greptile`, or `bin/ultrathink-mcp auth set-key greptile --stdin`. `bin/ultrathink-mcp auth status` shows whether it is ready. |
| `Knowledge · none` | Nothing to read: the git remote gives no `owner/repo`, Greptile has no knowledge base for that `owner/repo`, or the knowledge base has no published documents yet. The debug line gives the reason. | Check `git remote get-url origin` names the repository Greptile indexes (for example `acme/widgets`). A new repository needs Greptile to publish its knowledge base first. |
| `Knowledge · error` | A Greptile call failed, the account needs an organization, or a stage ran past its 20-second budget. One selected document that fails to read or times out is enough: the lookup is then `error` as a whole, never used with only some documents. The debug line reads `greptile knowledge base: error · <reason> · <ms>ms`. | For `Greptile account has several organizations; set ship.greptileOrganization …` (Greptile answered `tenant_required`), set `ship.greptileOrganization` to one of the listed ids or handles. A timeout or a failed document read needs no action: the questions were composed exactly as with the feature off. For other errors, check the credential with `bin/ultrathink-mcp auth status`. |
| A question you expected was not asked | The knowledge base settled it. Settled questions are listed in their own `### Settled from the Greptile knowledge base` subsection of the Clarifications (HITL) block as `- [k1] <question> → <answer> (Greptile knowledge base: <document>)`, marked as untrusted evidence the agent checks against the repository (asking you when the repository disagrees), not as your decisions. In the spec they appear as `<ANSWER source="knowledge" evidence="<document>">`. A claim that cites a document that was not read, or is otherwise invalid, is asked as an ordinary question. Product decisions and questions the clarifier marks blocking are always asked, never settled. | If the answer is wrong, say so in your next prompt; settled answers are not carried over to it. To stop settling questions this way, set `hitl.knowledgeBase: false`. |

## Decisions

Jev is always on (see [Configuration](configuration.md#decisions-jev-decisions-openrouter-decisions-api) and [Use Jev decisions](how-to/use-jev-decisions.md)): with a key for the resolved rail, ultrathink asks Jev over OpenRouter or Vercel at the points in `decisions.points`. Every failure fails open: the point behaves exactly as with Decisions off, and the error kind is shown where that point reports:

- plan, knowledge and blocking: the summary segment `Decisions · error (<kind>)`, with `claude.echo` on;
- ship: `decision.error` in the `bin/ultrathink-ship assess` JSON and the pull request line `- Jev: error (<kind>)`;
- every point, with `ULTRATHINK_DEBUG=1`: `[ultrathink] decisions <point> · error (<kind>) · <ms>ms · attempts <n>` on stderr.

None of these show the error message. To see it, run `bin/ultrathink decisions check` from the project directory: it sends one live decision and prints `Decisions check: error (<kind>) · <message> · <ms> ms · attempts <n> · provider <vercel|openrouter> · zdr <n/a (vercel)|on|off> · key from <source>`, where `<message>` is the redacted one-line error `decisions <kind>: <detail>`. The key is never printed.

| Symptom | Meaning | What to do |
|---|---|---|
| `Decisions: on · no Jev key (…)` | There is no key for the resolved rail, so no point sends a request. `decisions check` prints `Decisions check: no Jev key (…)` and exits 1. | Store a key for the rail you want: `bin/ultrathink-mcp auth set-key vercel --stdin` (or `AI_GATEWAY_API_KEY`), or `bin/ultrathink-mcp auth set-key openrouter --stdin` (or `ULTRATHINK_OPENROUTER_KEY`). The generic `OPENROUTER_API_KEY` is no longer read: if it is the only one set, `bin/ultrathink doctor` says so; store the key and remove the export. With `provider: "auto"`, a Vercel key picks the Vercel rail, else the OpenRouter rail is used. |
| `Decisions: off (ULTRATHINK_DECISIONS=0)`, `Decisions check: off (ULTRATHINK_DECISIONS=0)` or `Decisions probe: off (ULTRATHINK_DECISIONS=0)` | `ULTRATHINK_DECISIONS=0` is set in the environment. It turns every point off whatever the config says, and `decisions check` and `decisions probe` send nothing and exit 1. | Unset `ULTRATHINK_DECISIONS` in the host's environment to use Decisions. |
| `zdr n/a (vercel)` in the `Decisions:` line or the `decisions check` line, where you expected `zdr on` | Not a fault. The Vercel rail sends no zero-data-retention preference, so `decisions.zdr` does not apply to it and the line says so. `zdr on` or `zdr off` appears only on the OpenRouter rail. | If you need zero data retention, pin `decisions.provider: "openrouter"` with `decisions.zdr: true` and an OpenRouter key; see [Privacy](privacy.md#jev-decisions-openrouter). |
| `ultrathink-mcp: empty api key`, `ultrathink-mcp: vercel api key must not contain whitespace or control characters` or `ultrathink-mcp: vercel api key must be 16 to 512 characters (got <n>)` from `auth set-key vercel` | The key was refused before anything was stored. The message never repeats the key. A pasted key often carries a line break or a space in the middle, or the paste was cut short or doubled. There is no live verify endpoint for the gateway key, so `--no-verify` is accepted and does nothing. | Copy the key again without surrounding text and run `bin/ultrathink-mcp auth set-key vercel --stdin`. Then run `bin/ultrathink decisions check`: that is the first request that can show a rejected key (`error (auth)`). |
| ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` at the end of the `Decisions:` line or the `decisions check` line | `ULTRATHINK_DECISIONS_URL` is set, but it is not an `https://openrouter.ai/…` URL or an `http://` or `https://` URL on `localhost`, `127.0.0.1` or `[::1]`, or it has a user name or password in it. It is ignored, and requests go to the default endpoint. | Point it at `openrouter.ai` or a proxy on this machine, without credentials in the URL, or unset it. |
| `Prompt Uplift · not planned: Jev judged this is not new multi-step work (<P>) · start with uplift: to plan it` | Jev's P(`plan_worthy`) was below `decisions.planSkipBelow` (0.2), so the message went to the agent unplanned, exactly like a skipped short reply. Nothing was written to the state directory. | Resend it with `uplift:` in front to plan it. If Jev skips messages you want planned, lower `decisions.planSkipBelow`, or remove `plan` from `decisions.points`. Check with `bin/ultrathink decisions probe plan <cases.json>`. |
| `error (auth)`: `decisions auth: HTTP 401: …` (OpenRouter answers `User not found.` for an unknown key) or HTTP 403 | The rail refused the request: a rejected key on most rails, or missing purchased credits on the Vercel rail (see right). Not retried. It opens the Jev health breaker (see `error (unavailable)` below). | Store a valid key for the rail in use (check the `provider` segment): `bin/ultrathink-mcp auth set-key vercel --stdin` or `bin/ultrathink-mcp auth set-key openrouter --stdin`. A stored key wins over the environment key on its rail, so a stale stored key hides a good environment key: check the status line's `key from …`, and remove the stored one with `bin/ultrathink-mcp auth logout <provider>`. Exception: on the Vercel rail, HTTP 403 `Free tier users do not have access to this model` for `typesafe-ai/jev` is not a key problem — Jev needs purchased AI Gateway credits, and the free-tier allowance does not unlock it. Add credits on the AI Gateway page ([pricing](https://vercel.com/docs/ai-gateway/pricing)); Jev calls cost fractions of a cent, so a small top-up lasts a long time. |
| `error (credits)`: `decisions credits: HTTP 402: …` | The rail's account has too few credits. Not retried. It opens the Jev health breaker (see `error (unavailable)` below). | Add credits in your Vercel or OpenRouter account, then run `bin/ultrathink decisions check`; `ok` closes the breaker (`breaker closed`). One OpenRouter decision costs about $0.000019. |
| `error (unavailable)`: `Jev unavailable: <rail> reports insufficient credits since <date>. …` or `Jev unavailable: <rail> rejected the key since <date>. …`, where `<rail>` is `OpenRouter` or `Vercel AI Gateway`, also at the end of the `Decisions:` line of `bin/ultrathink status`, as a `decisions.health` warning in `bin/ultrathink doctor` and once as `Jev · unavailable (credits\|auth)` in the planning summary | The health breaker for that rail is open: an HTTP 402 or a 401/403 was seen, so no request is sent until the next check (5 minutes after it opened, doubling to a cap of 6 hours). Meanwhile every point uses its existing default (the plan gate plans every prompt); no other model, provider or key is tried. Only the claimed probe or an explicit `decisions check` closes it. The state is `<state dir>/decisions-health-openrouter.json` or `decisions-health-vercel.json`; the old `decisions-health.json` is no longer read. | Fix the cause on the named rail: top up at `https://openrouter.ai/settings/credits` or add credits in the Vercel AI Gateway dashboard, or store a valid key with `bin/ultrathink-mcp auth set-key <rail> --stdin`. Then run `bin/ultrathink decisions check`: `ok` closes the breaker at once (the line ends with `breaker closed`), so you do not have to wait for the cool-down. `breaker still open: <cause>` means the rail still refuses, and `breaker opened: <cause>` means this check opened it. To confirm only Jev is spending the key, open the OpenRouter dashboard's per-model breakdown (it should list only the Jev model) and compare with `bin/ultrathink decisions usage`. |
| `error (model)` | A non-Jev model id reached Decisions. Only `typesafe/jev*` ids are sent, so the request was refused before any network call. A `decisions.model` that is not a Jev id in a config file is ignored: the earlier layers' value stays (an invalid project value keeps a user's pinned Jev version), and the default alias applies only when no layer holds a valid Jev id. | Use `~typesafe/jev-latest` or a `typesafe/jev-<version>` id, or remove `decisions.model`. |
| The OpenRouter dashboard shows models other than Jev, or spend while ultrathink is idle | Not ultrathink: it sends only Jev to OpenRouter and never passes the key to a child process. Something else holds the key, often a shell profile or service unit that exports `OPENROUTER_API_KEY` (ultrathink no longer reads it, but SDKs and agents do). | Remove the export, restart the shells and services that had it, rotate the key in the OpenRouter dashboard, and store the new one with `bin/ultrathink-mcp auth set-key openrouter --stdin`. `bin/ultrathink doctor` warns while the variable is exported. |
| `error (timeout)`: `decisions timeout: no answer within 3000 ms` (the number is `decisions.timeoutMs`), or a final HTTP 408 | No answer within the budget, retry included. | Nothing, if it is rare. On a slow network raise `decisions.timeoutMs` (for example to `5000`; values above `30000` are ignored); planning and ship wait up to that long for Jev. |
| `error (rate-limit)`: `decisions rate-limit: HTTP 429: …` | The rail throttled the request; it was retried once when the budget allowed. | Nothing, if it is rare. Otherwise wait, or ask Jev at fewer points (`decisions.points`). |
| `error (upstream)`: `decisions upstream: HTTP <status>: …` | The rail or the model provider failed. 500, 502, 503, 524 and 529 are retried once when the budget allows. | Nothing: the point ran as with Decisions off. Try `decisions check` later. |
| `error (network)`: `decisions network: <reason>` | The request did not reach the rail (DNS, proxy, no network), or the server answered with a redirect, which is never followed; retried once when the budget allowed. | Check the machine's network, and that `ULTRATHINK_DECISIONS_URL`, if set, points at a reachable server. |
| `error (invalid-response)`: `decisions invalid-response: <rule>`, for example `decisions invalid-response: answers.plan_worthy.noul must be a finite number in [0, 1]` | The answer did not pass the strict check: a missing or extra answer key, a wrong type, a value out of range, or a body that is not JSON. It is never read as 0. The Decisions API is alpha, and its shape may change. | Run `decisions check`. If it persists, pin `decisions.model` to `typesafe/jev-1.13` and report it with the `decisions check` line. |
| `error (too-large)`: `decisions too-large: request is about <n> tokens (limit 28000)`, or HTTP 413 | The state was over the size limit, so nothing was sent (or the rail refused it). Most often a ship check with a very long original prompt. | Nothing: that point ran as with Decisions off. |
| `error (bad-request)`: `decisions bad-request: HTTP 400: …` or `HTTP 404: …` | The rail refused the request, often because of an unknown `decisions.model`. Not retried. | Check `decisions.model` (`~typesafe/jev-latest` or `typesafe/jev-1.13`), then run `decisions check`. |
| Ship: `- Jev: P(complete) <P> · <model> · veto` in the PR body's assessment, or a veto gap from `assess` | See the `assess` rows in [Ship is blocked](#ship-is-blocked). With `ship.judge: "advisory"` the line reads `- Jev: P(complete) <P> · <model> · veto (advisory: shipped anyway)` and the PR opened anyway. | Finish the missing work. If Jev vetoes complete changes of your kind, lower `decisions.shipVetoAtOrBelow` after probing your cases with `bin/ultrathink decisions probe ship <cases.json>`, or remove `ship` from `decisions.points`. |
| A question you expected the knowledge base to settle was asked or is missing, or a question became blocking | Jev's P(`supported`) was below `decisions.groundedAt` (0.8), so the settled answer was taken back: it is asked after the clarifier's own questions while fewer than `hitl.maxQuestions` are open, and dropped (neither settled nor asked) when no slot is left; or its P(`risky`) was at or above `decisions.blockingAt` (0.5), so the question is asked before work starts. The summary shows `Decisions · knowledge <kept>/<n> kept` and `Decisions · blocking <promoted>/<n> promoted`. | Answer the question. To change how often it happens, tune `groundedAt` or `blockingAt` after probing with `decisions probe knowledge` or `decisions probe blocking`. |
| `Jev · <decision> · confidence <n> · <OpenRouter\|Vercel> · <model>`, optionally followed by ` · <request id>`, then `. This does not clear a human pause.`, in the context a GSD flow command (a `gsd-autonomous` skill or phase command) returns; or `Jev · skipped · empty output. Not an approval.`; or `Jev · error · <class> · retries <n>. Not an approval. Do not mark this output Jev-approved.` | The PostToolUse flow hook scored the command's output through Jev. The note names the rail that decided: `OpenRouter` or `Vercel`, the same rails as `decisions.provider`. It is a score, never an approval: it does not clear a human pause. With no Jev key on the picked rail the hook decides nothing, prints nothing and writes nothing (inactive), and the same holds under `ULTRATHINK_DECISIONS=0`. | Treat the note as advice. For `error`, run `bin/ultrathink decisions check` to see the kind and the key source, then see the `error (<kind>)` rows above. For silence, store a key for the rail you want (`bin/ultrathink-mcp auth set-key vercel --stdin` or `bin/ultrathink-mcp auth set-key openrouter --stdin`) and unset `ULTRATHINK_DECISIONS`. |

## Credential store

`bin/ultrathink doctor` checks the credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json` (or the path in `ULTRATHINK_MCP_STORE`), in its `credentials` section. Both findings print the path and never the file's content.

| Finding | Meaning | What to do |
|---|---|---|
| `credentials.store.unreadable` (warn): `Credential store does not parse: <path>` | The file exists but is not a version 1 credential store (cut off, edited by hand, or from another tool), so every stored credential reads as missing: Jev, Hindsight and the MCP servers then report no credential. | Restore the file from a backup, or remove it and store the keys again: `bin/ultrathink-mcp auth set-key <provider> --stdin` for API keys, `bin/ultrathink-mcp auth login <provider>` for Notion, Linear and Greptile. |
| `credentials.store.mode` (warn): `Credential store is readable by group or others (mode 0644): <path>` | The file holds API keys and OAuth tokens and its permissions let another local user read it. ultrathink writes it with mode 0600; a copy, a backup restore or an editor can change that. | Run the fix the finding names: `chmod 600 <path>`. If the keys may have been read by someone else, rotate them. |

## Hindsight

Hindsight is opt-in. See [Configuration](configuration.md#hindsight-memory-server) and [Connect Hindsight](how-to/connect-hindsight.md) (`docs/how-to/connect-hindsight.md`). `bin/ultrathink hindsight check` exits 0 when `/health` reports healthy, 1 when the integration is not ready or the probe fails, and 2 on a usage error.

| Symptom | Meaning | What to do |
|---|---|---|
| `Hindsight: off (opt-in: set hindsight.enabled)` | The default. A project file cannot turn it on. | Set `hindsight.enabled: true` in `~/.config/ultrathink/config.json`, with `url` and `bank`. |
| `Hindsight: off (ULTRATHINK_HINDSIGHT=0)` | The exact string `0` is set. No request is made. | Unset `ULTRATHINK_HINDSIGHT` in the host's environment. |
| `Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)` | Enabled, but neither the config URL nor an environment URL is set. `HINDSIGHT_API_URL` is the canonical name and is read first; `HINDSIGHT_URL` is read as a fallback when it is unset or blank. | Set `hindsight.url` in a user file, or set `HINDSIGHT_API_URL` (or `HINDSIGHT_URL`). Do not put a production URL in a project file: it is ignored. |
| `Hindsight: on · bad URL (<reason>)` | The URL was refused. `http` is allowed only for `localhost`, `127.0.0.1`, `[::1]`, `*.ts.net` and `100.64.0.0/10`. A user name, password, query or fragment is refused. | Fix the URL. The status line shows the reason and never the key. |
| `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)` | No stored `hindsight` key, and `HINDSIGHT_API_KEY` is empty. | Run the command the line names. `HINDSIGHT_API_TOKEN` is also accepted, after the stored key and `HINDSIGHT_API_KEY`. A stored key wins. |
| `Hindsight check: error (auth)` | The server rejected the key. | Store a valid key with the command the status line names. `bin/ultrathink-mcp auth logout hindsight` removes a stale stored key that hides a good environment key. |
| Lessons are not retained, or a retain times out | The server has no LLM, and a mode other than `chunks` would call one. | Leave the bank in `chunks` mode. The client sets `retain_extraction_mode` to `chunks` itself. Do not enable verbatim or reflect. |

`--roundtrip` proves retain, recall and delete in a throwaway `ultrathink-smoke-*` bank and then deletes that bank. It does not touch the configured bank. A failed step still runs the cleanup steps.

## RAGFlow

RAGFlow is opt-in. See [Configuration](configuration.md#ragflow-document-search) and [Connect RAGFlow](how-to/connect-ragflow.md) (`docs/how-to/connect-ragflow.md`). `bin/ultrathink ragflow check` exits 0 when the datasets probe answers, 1 when not ready or the probe fails, and 2 on a usage error.

Never probe `/system/healthz`, `/v1/system/healthz` or `/api/v1/system/healthz`. On a deployment whose object storage is down, that route can block the API worker for minutes. The client does not call it. Health is the datasets probe the client uses: `GET /api/v1/datasets?page=1&page_size=1`, which is what `bin/ultrathink ragflow check` runs. `datasets` lists what the key can see. `search "<question>"` retrieves chunks.

| Symptom | Meaning | What to do |
|---|---|---|
| `RAGFlow: off (opt-in: set ragflow.enabled)` | The default. A project file cannot turn it on or turn `ground` on. | Set `ragflow.enabled` in a user file. Set `ground` only if plans should include excerpts. |
| `RAGFlow: off (ULTRATHINK_RAGFLOW=0)` | That variable is `0` (whitespace around it is trimmed). | Unset it. |
| `RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)` | No stored `ragflow` key, and `RAGFLOW_API_KEY` is empty. | Run the command the line names. A stored key wins over `RAGFLOW_API_KEY`. |
| `RAGFlow check: error (auth)` | The server rejected the key (HTTP 401/403, or body code 109/108). | Store a valid key with the command the status line names. |
| No `Docs` segment in the summary | `ragflow.ground` is off, RAGFlow is not ready, or the lookup found nothing. Grounding fails open: the plan is unchanged. | Turn `ground` on in a user file, then `bin/ultrathink ragflow check`. `Docs · error (<reason>)` names the failure; nothing else to do for one failed lookup. |

## Teachable Moments

On by default (`enabled`, `auto` capture, auto-promote). See [Configuration](configuration.md#teach-teachable-moments) and [Use Teachable Moments](how-to/use-teachable-moments.md) (`docs/how-to/use-teachable-moments.md`). On Hermes, see [Teachable Moments on Hermes](how-to/teachable-moments-on-hermes.md) (`docs/how-to/teachable-moments-on-hermes.md`).

State is `<stateDir>/teach/` (`moments/`, `outbox/`, `inbox/`, `skill-drafts/`). `ULTRATHINK_STATE_DIR` overrides the state directory and is ignored when it points into `.planning`. Nothing is written into `<cwd>/.planning`.

| Symptom | Meaning | What to do |
|---|---|---|
| `Teach: off (opt-in: set teach.enabled)` | Off: a user file set `enabled: false` (a project file's `enabled: true` cannot override that). | Remove the `false`, or set `teach.enabled: true` in `~/.config/ultrathink/config.json`. |
| `Teach: off (ULTRATHINK_TEACH=0)` | Enabled, and the exact string `0` is set. Mutating `teach` commands exit 1. | Unset `ULTRATHINK_TEACH`. |
| `Teach: on · … · Hindsight no key` | Lessons stay local. A retain is not attempted. | Fix the `Hindsight:` line. The word after `Hindsight` is `ready`, `off`, `no URL`, `bad URL` or `no key`. |
| `retain queued` | The local file was written. Hindsight did not take it. The outbox retries (1 minute, doubling, capped at 6 hours). | `bin/ultrathink teach sync` after Hindsight is ready. A failure does not block the caller. |
| `promote --due` lists nothing you expected | The moment is not confirmed, occurrences are below `teach.promoteAfter` (unless kind is `playbook`), or Jev's P(`skillworthy`) was below `skillworthyAt`. | Confirm it, or `teach promote <id>` which does not ask `skillworthy`. A last line `Jev skipped <n> moment(s): not worth a standing skill.` is that gate. |
| Hermes skill did not appear under `~/.hermes/skills` | ultrathink never writes that directory. `--install --target hermes` only drafts under `<stateDir>/teach/skill-drafts/`. | Install through Hermes `skill_manage`, so `skills.write_approval` applies, then `teach promote <id> --mark-promoted --skill <name> --target hermes`. |
| No new lessons are captured | Every agent run that starts from a prompt of yours, a typed message or a `/skill:<name>` you invoked, starts a detached `teach observe` whose output is ignored, so a failing distiller prints nothing. A streak of failed runs shows on the `Teach:` status line (`observe failing ×<n> since <time> UTC (<reason>)`) and as one `teachable-failed` card on the first failure and every tenth. Each run is logged as one small JSON file in `<stateDir>/teach/runs/` (50 are kept, the newest; runs skipped before the distiller was asked go first once the log is full). A run that resumes on an agent-side message alone, such as an async result or a ship nudge, has no prompt of yours and is not captured. | Run `bin/ultrathink doctor` and read its `memory` section: it warns when nothing was captured for 3 days although a session ran in the last 24 hours and no observe run was recorded in those 3 days. Then read the newest files in `<stateDir>/teach/runs/`. The common reason is `skipped: "distiller failed"` with `detail: "Credit balance is too low"`: an `ANTHROPIC_API_KEY` with no credit shadows your plan login. With the default `claude.auth: "plan"` ultrathink starts the `claude` child without that variable, so the distiller runs on the plan login; if you still see the text, `claude.auth` is `"api-key"`, or the `claude` CLI has no plan login (`claude auth status`). Sign in with `/login`, or set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. See [Claude plan-first auth](how-to/choose-engine.md#claude). `skipped: "lesson not saved"` means a lesson was distilled but the store refused it: check that `<stateDir>/teach/` is writable. With no run files at all, restart the host: it builds the digest in its own process, so one started before a plugin update keeps the old capture code (an Omp run you started with `/skill:<name>` produced no digest before that fix). |
| `claude CLI not found: the Claude route cannot plan` (`inference.claude.cli`, warn) with a detail that starts `The memory-bank distill also needs it` | The `claude` CLI is not on `PATH` and the distill is active (`teach.enabled` on, `ULTRATHINK_TEACH` not `0`, `teach.capture` not `explicit`). The distill runs `claude-haiku-5-5` through the CLI (Claude Code 2.1.293 or newer), so without it, and without a Grok fallback that is on and signed in, every turn ends as `distiller failed` and nothing is captured. | Install Claude Code, or set `"teach": { "capture": "explicit" }` to stop the background distill. See [Choose an engine: memory-bank chain](how-to/choose-engine.md#memory-bank-chain). |

## Redaction

Before a lesson is stored or sent, `Bearer` plus a token is redacted only when the token looks like a credential. `Bearer` plus a short English word is left as prose: `the Bearer key` and `Bearer token rotation` stay. A token is replaced with `[redacted]` when it is at least 16 characters, or at least 6 characters and contains a digit. Trailing dots stay after `[redacted]`. A short word with no digit, such as `Bearer token`, is not a credential.

The same pass redacts PEM private keys, URL userinfo, assignment-shaped secrets, and home-directory paths that are outside the repository. The replacement `[redacted]` matches no pattern, so running it again changes nothing. A redaction failure yields `[redacted]` rather than the original text.

## Stack

`bin/ultrathink stack` reports the five USSR Stack links (`substrate`, `swarm`, `realm`, `decisions`, `hindsight`), one line each in the form `<member>  <status>  <reason>`. A member that has a fix prints an indented `fix: <command or variable>` line under it. `--json` prints one object, `{ members, generatedAt }`. Every reason and fix is secret-free and passes the redactor before it is printed. The status is one of `connected`, `degraded`, `unavailable`, `misconfigured` or `disabled`; `disabled` means switched off or never opted in, and nothing is contacted.

Without `--live` every probe is free and read-only. The command exits 0 whatever it finds, 1 under `--strict` when any member is `misconfigured` or `unavailable`, and 2 on a usage error (it then prints `Usage: ultrathink stack [--live] [--json] [--strict] [--only <member>]... [--timeout <ms>]`). `--live` also runs the Decisions check, which costs a request: `--live also runs the Decisions check (spends one request; moves the rail breaker and writes a usage row exactly like `decisions check`)`. `bin/ultrathink status` carries a one-line summary that never touches the network: `Stack: <n> ready · <n> off · <n> missing (run ultrathink stack)`, with a bucket left out when it is empty.

The Substrate, Swarm and Realm links have their own sections: [Substrate brief](#substrate-brief), [Swarm lanes](#swarm-lanes) and [Realm](#realm).

| Symptom | Meaning | What to do |
|---|---|---|
| `hindsight  misconfigured  no Hindsight URL` | Hindsight is enabled but no URL is set. | `set hindsight.url or HINDSIGHT_API_URL (HINDSIGHT_URL also works)`, as the `fix:` line says. See [Hindsight](#hindsight). |
| `hindsight  misconfigured  no Hindsight key` | No stored key and no key variable. | `bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY`. |
| `hindsight  unavailable  Hindsight did not answer its health check (<kind>)` | The server was reached or tried and the health call failed; `<kind>` is the error kind (for example `auth`). | Run `bin/ultrathink hindsight check`, and see [Hindsight](#hindsight). |
| `hindsight  disabled  Hindsight is opt-in and hindsight.enabled is off`, or `ULTRATHINK_HINDSIGHT=0 turns Hindsight off for this process` | Not a fault. Nothing is contacted. | Set `hindsight.enabled` in a user file, or unset `ULTRATHINK_HINDSIGHT`. |
| `decisions  misconfigured  no Jev key on either rail` | No Vercel and no OpenRouter key is stored or exported. | `bin/ultrathink-mcp auth set-key vercel --stdin, or bin/ultrathink-mcp auth set-key openrouter --stdin`. |
| `decisions  misconfigured  no Jev key: OPENROUTER_API_KEY is exported but Ultrathink does not read it` | The generic `OPENROUTER_API_KEY` is the only key present, and ultrathink does not read it. | `bin/ultrathink-mcp auth set-key openrouter --stdin`, then remove the export. See the Credential store and Environment sections below. |
| `decisions  degraded  Jev breaker open on <rails>; decisions are skipped until it re-checks` | The health breaker of at least one rail is open after a 402, 401 or 403; each rail is listed with its cause, for example `openrouter (credits)`. | `bin/ultrathink decisions check`: an `ok` closes the breaker. See the `error (unavailable)` row in [Decisions](#decisions). |
| `decisions  unavailable  live check failed on the <rail> rail (<kind>)` | `--live` sent the one decision and it failed; `<kind>` is the error kind. For `auth` the fix line is the `set-key` command, for `credits` it is `add credits to the provider account`. | See the `error (<kind>)` rows in [Decisions](#decisions). |
| `decisions  unavailable  Decisions probe failed unexpectedly` | The probe threw; no detail is shown, because it could carry a credential. | Run `bin/ultrathink decisions check` for the redacted error. |
| `decisions  disabled  ULTRATHINK_DECISIONS=0 turns Jev decisions off for this process` | The kill switch is set. | Unset `ULTRATHINK_DECISIONS`. |
| `stack.<member>` finding in `bin/ultrathink doctor` (a warn for `unavailable` or `misconfigured`, an info for `degraded`) | Doctor's `stack` section runs the same probes as `ultrathink stack` without `--live`. The title is `<member>: <reason>` and the fix is the member's own fix. A `connected` or `disabled` member yields nothing. | Run `bin/ultrathink stack` and follow the row of the member. |
| `stack.report` finding: `stack check failed` | The section itself threw. The error text is never shown, because it could carry a URL or a credential. | Run `bin/ultrathink stack` directly. |

## Environment

`bin/ultrathink doctor` checks the environment in its `env` section. Each problem is one `env.<name>` warning. A finding names variables and expectations and never a value. The full list of variables is in the generated [Environment reference](environment.md).

| Symptom | Meaning | What to do |
|---|---|---|
| `env.<name>` warning: `<name> must be an integer`, `<name> must be between <min> and <max>`, `<name> must be 0 or 1`, `<name> must be one of <values>`, `<name> must be an absolute path`, `<name> must be an absolute http(s) URL` | The variable is set to a value its reader would not accept. | Fix it as the finding says: `correct <name> or unset it (see docs/environment.md)`. |
| `env.<canonical name>` warning: `<canonical name> and <alias> are both set to different values; <canonical name> wins` | A variable and its alias disagree. The canonical name is read first, so the alias is silently ignored. | `set <CANONICAL> (or remove <ALIAS>)`. For example `set HINDSIGHT_API_URL (or remove HINDSIGHT_URL)`. |
| `env.<name>` warning: `<name> is set but only the value <value> has an effect, so it disables nothing` | A kill switch is set to something other than its disabling value. The polarity differs: `SUBSTRATE_DISABLED=1` turns Substrate off, the `ULTRATHINK_*` switches such as `ULTRATHINK_DECISIONS`, `ULTRATHINK_HINDSIGHT` and `ULTRATHINK_RAGFLOW` turn a link off with `0`, and `ULTRATHINK_REALM=off` switches the Realm probe off. Any other value changes nothing. | `unset it or set it to <value>`, where `<value>` is the disabling value the finding names. |
| `credentials.openrouter-export` (warn): `OPENROUTER_API_KEY is exported: Ultrathink no longer reads it (Jev uses the credential store or ULTRATHINK_OPENROUTER_KEY), so the export only lets other tools in this environment spend the key` | The generic variable is exported in the environment doctor ran in. | `remove the export from your shell profile or service unit`. |
| `credentials.jev.legacy` (warn): `Jev decisions: OPENROUTER_API_KEY is set but Ultrathink no longer reads it` | `OPENROUTER_API_KEY` is the only Jev key present, so Jev has no key. | `bin/ultrathink-mcp auth set-key openrouter --stdin`, then remove the export. |
| `credentials.store.unreadable` and `credentials.store.mode` | The credential store does not parse, or other users can read it. | See [Credential store](#credential-store). |

## Hosted service

The hosted ultrathink service reads its whole configuration from the environment when it starts, and `--check-config` does the same without opening a store or a socket. Every configuration problem is collected and printed together, never one per start.

| Symptom | Meaning | What to do |
|---|---|---|
| `ultrathink: <n> configuration problems`, followed by one indented line per problem, on stderr, then exit 1 | At least one variable is missing, malformed or contradicts another. Each line names the variables and the expectation, never a value. The service does not start. | Fix every listed variable (see the [Environment reference](environment.md)), then run the service with `--check-config` again. |
| `config ok` on stdout, exit 0, from `--check-config` | The environment is valid. Nothing was opened or started. | Nothing. |
| `warning: ULTRATHINK_MODEL_TIMEOUT_MS and ULTRATHINK_PLAN_TIMEOUT_MS are both 0 …` on stderr from `--check-config`, still followed by `config ok`, exit 0 (also the log line `timeouts_unset` and the doctor warning `runtime.service-timeouts`) | Server planning is on and neither timeout is set. The defaults stay 0 by policy, so a model call that hangs is never stopped. | Set `ULTRATHINK_PLAN_TIMEOUT_MS` (30000 to 1800000) and/or `ULTRATHINK_MODEL_TIMEOUT_MS` (5000 to 600000), or accept it and cancel hung plans with `ultrathink_cancel`. See [Under load](#under-load). |

## Substrate brief

The Agent Substrate brief is optional. When a Substrate is configured and a prompt gets no usable brief, the planning summary (with `claude.echo` on) carries one segment, `Substrate · brief unavailable (<phrase>)`. The phrase comes from a closed set, so it never carries a token, a URL or the server's message. No segment appears when no Substrate is configured, when the brief is usable (complete, degraded or snapshot), or when the answer was empty with no reason. Planning is never blocked.

| Symptom | Meaning | What to do |
|---|---|---|
| `Substrate · brief unavailable (unauthorized)` | The Substrate answered HTTP 401: it refused the bearer token. | `set SUBSTRATE_TOKEN (or SUBSTRATE_TOKEN_FILE / SUBSTRATE_TOKENS_DIR per-surface files)`. The token is read from `SUBSTRATE_TOKEN`, else the first line of the file named by `SUBSTRATE_TOKEN_FILE`, else the file named for the host's surface in `SUBSTRATE_TOKENS_DIR`. |
| `Substrate · brief unavailable (surface mismatch, retry skipped)` | The Substrate answered 403 because the token cannot act as the host's surface. ultrathink retries once without the surface, but fewer than 300 ms of the brief budget were left, so the retry was skipped. | Raise `SUBSTRATE_TIMEOUT_MS`, or use a token issued for the host's surface (a per-surface file in `SUBSTRATE_TOKENS_DIR`). |
| `Substrate · brief unavailable (bad request)` | The Substrate answered HTTP 400. | Run `bin/ultrathink stack --only substrate` and check that the Substrate is a version that serves `/brief`. |
| `Substrate · brief unavailable (timed out)` | No answer within the brief budget. | Check the Substrate, or raise `SUBSTRATE_TIMEOUT_MS`. |
| `Substrate · brief unavailable (unreachable)` | The connection was refused or failed, or the body could not be read. | Check `SUBSTRATE_URL` (or `substrate.url` in a user config file; a project file's value is ignored) and that the Substrate is running. |
| `Substrate · brief unavailable (redirect refused)` | The Substrate URL answered with an HTTP redirect. ultrathink refuses to follow it, so the bearer token cannot be forwarded to another address. | Set `substrate.url` (or `SUBSTRATE_URL`) to the final `https` address the redirect points to. |
| `Substrate · brief unavailable (url refused)` | The Substrate URL breaks the service-URL policy, so no request was sent. The policy: `https`, or `http` only to `localhost`, `*.ts.net` or `100.64.0.0/10`, with no user name, password, query or fragment. The specific reason (`url refused: <reason>`) is kept out of the summary. | Correct `substrate.url` (or `SUBSTRATE_URL`) to a URL that meets the policy. |
| `Substrate · brief unavailable (http-<status>)`, for example `http-503` | Any other non-2xx answer; `<status>` is the three-digit code. | Check the Substrate's own health. |
| `substrate  connected  brief via token surface <s> for host <h>` in `ultrathink stack` | Not an error. The token's surface differs from the host's; the brief was retried without the surface and recovered. | No action needed. |

What `bin/ultrathink stack --only substrate` shows for the same causes:

| Symptom | Meaning | What to do |
|---|---|---|
| `substrate  disabled  SUBSTRATE_DISABLED=1` | The kill switch is set. | Unset `SUBSTRATE_DISABLED` to use the Substrate. |
| `substrate  disabled  no Substrate URL (set SUBSTRATE_URL or substrate.url)` | Nothing configures a Substrate. It is optional. | Set `SUBSTRATE_URL`, or `substrate.url` in a user config file. |
| `substrate  unavailable  healthz unreachable` | The open `/healthz` request failed. | Check that the Substrate is running and `SUBSTRATE_URL` points at it. |
| `substrate  misconfigured  brief refused the bearer (401)` | The same cause as `unauthorized` above. | `set SUBSTRATE_TOKEN (or SUBSTRATE_TOKEN_FILE / SUBSTRATE_TOKENS_DIR per-surface files)`, as the `fix:` line says. |
| `substrate  unavailable  brief request rejected (400)`, `brief timed out` or `brief unreachable` | The same causes as `bad request`, `timed out` and `unreachable` above. | See the rows above. |

## Swarm lanes

`/ultrathink-swarm <brief>|<brief>|…` (and Omp's auto-run, when `swarm.autoRun` is on) starts one detached AgentSwarm orchestrator lane per brief. Two lanes in one repository share one working tree and its branches. The explicit `/ultrathink-swarm` command joins the session's most recent tracked plan by its Graph ID; auto-run does not, because it runs before the prompt is planned. The lane's real output is `autonomous.log`, `events.jsonl` and `results/` in its state directory, `<state dir>/swarm/<lane>/`; `run.log` there is only the wrapper's own stdout.

| Symptom | Meaning | What to do |
|---|---|---|
| `Swarm would skip this brief (not SDLC work)` | The classifier that Swarm itself runs (`signal_detector`) does not read the brief as SDLC work, so Swarm would drop it silently. The brief is refused up front and no lane starts. | Rephrase it as build or test work, or do the task outside a lane. |
| `classifier unavailable — spawned without preflight` | The classifier could not answer (no `python3`, a wrong Swarm root, or a timeout), so the lane was started without the preflight. | `set ULTRATHINK_SWARM_ROOT (or SWARM_ROOT) to an absolute agent-swarm checkout`, and install `python3`. Check with `bin/ultrathink stack --only swarm`. |
| `already running as <laneId> (pid <pid>) in <cwd>; stop a lane with /ultrathink-swarm stop [laneId\|all] to replace it` | The same brief is already running in this directory. | Run the stop command the message names, then start the brief again. |
| `<laneId>: duplicate of <earlierLaneId> in this command` | Two briefs in one `/ultrathink-swarm` command normalize to the same text (trimmed, whitespace-collapsed, lower-cased), so only the first starts. The later one takes no slot. | Nothing, or give the later brief different wording. |
| `<laneId>: lane.json not written (<reason>); status, stop and the live-lane cap cannot see this lane` (beside the spawn card or reply) | The lane started, but its identity file could not be written, so it is invisible to `stop`, the duplicate check and the cap. | Check that the state directory is writable, then end the lane from your own shell (`ps` for `autonomous_run.py`). |
| `Swarm lane cap reached: <n> live plus <m> starting lane(s), limit <c> (ULTRATHINK_SWARM_MAX_LANES); stop a lane with /ultrathink-swarm stop [laneId\|all].` (also `Swarm lane cap reached: <n> live lane(s), limit <c> (ULTRATHINK_SWARM_MAX_LANES).` followed by one line per live lane and `To free a slot, stop a lane with /ultrathink-swarm stop [laneId\|all].`) | Live lanes, counted across all commands, are at the limit. | Stop a lane, or raise `ULTRATHINK_SWARM_MAX_LANES` (default 3, at most 6). |
| `another ultrathink process is starting lanes (lane lock busy); try again in a moment` (followed by ` (held by process <pid>; if that process is gone, remove <lock directory>)` when the holder is known) | Another Omp session is starting lanes right now, or a hung or crashed one holds the lane lock. A lock held by a live process is never taken over, however long it has been held; a lock whose holder has died is cleared automatically, and a holder is recognised by process id and start time, so a recycled process id does not keep a dead holder's lock alive. The message names the holder. Nothing was started. | Retry in a moment. If the message names a process that is gone and the lock stays, remove the directory it names. |
| `cannot take the lane lock (<code>)` | The lane lock directory under `<state dir>/swarm/` could not be created, usually because the state directory is not writable. Nothing was started. | Check the permissions and free space of the state directory. |
| `<laneId>: pid <pid> no longer belongs to the lane — ignored` (from `/ultrathink-swarm stop`) | The pid in the lane's `lane.json` now belongs to a different process: the lane's process ended and the pid was reused. `stop` did not signal it. | Nothing: the lane is gone. |
| `<laneId>: could not verify pid <pid>; not signalled` (from `/ultrathink-swarm stop`) | `stop` could not read `/proc/<pid>` (a `hidepid` mount, a process of another user, or the process exiting at that moment), so it did not risk signalling the wrong process. The lane stays listed and still counts against the cap. | Run `stop` again. If the lane is yours and still running, check `ps -p <pid>` and end it from your own shell. |
| `<laneId>: already exited` (from `/ultrathink-swarm stop`) | The lane's process ended before `stop` signalled it. | Nothing. |
| Lane state `planning`: `waiting for the plan (no correlation yet)` | The lane process is live but has not written its plan yet. | Wait, then run `/ultrathink-swarm status` again. |
| Lane state `running` | The lane process is live and its tasks are in progress; none is FAILED, ESCALATED or BLOCKED (those read `attention`, even while the process runs). | Nothing. |
| Lane state `skipped`: `duplicate of an earlier run (digest <digest>)` | Swarm recognised the brief as a duplicate of an earlier run and did nothing. | Nothing, or change the brief. |
| Lane state `plan-failed`: the row carries Swarm's error code and message | The orchestrator exited with an error and no plan (an exit-2 error body in `autonomous.log`). | Read the code and message in the row, then `autonomous.log` in the lane's state directory. |
| Lane state `done` | All tasks are complete. | Nothing. |
| Lane state `attention`: tasks in a state that needs a human (FAILED, ESCALATED or BLOCKED), an escalated task, a non-zero run exit, or `no live lane process and the tasks are unfinished` | Some task needs a person, or the lane has no live process and unfinished tasks. When the detail ends with `process still running`, the orchestrator is alive but a task is stuck waiting for you: Swarm does not release FAILED, ESCALATED or BLOCKED tasks by itself. | Read the detail in `/ultrathink-swarm status`, then `autonomous.log`, `events.jsonl` and `results/` in the lane's state directory. |
| Lane state `not-planned`: `no plan, no running process, no log` or `no plan and no running process; autonomous.log is unreadable` | The lane never produced a plan and nothing is running. | Check `autonomous.log` in the lane's state directory, then start the brief again. |
| `swarm  degraded  <n> lane(s) started in the last 24 h need attention (see /ultrathink-swarm status)` in `ultrathink stack` | Lanes started within the last 24 hours are in the `attention` state. Older lanes never degrade the link; they still show in `/ultrathink-swarm status`. | `stop a lane with /ultrathink-swarm stop [laneId\|all]`, or read the lane as in the `attention` row. |
| `swarm  unavailable  Swarm classifier unavailable: <reason>` in `ultrathink stack` | The probe could not run the classifier. | `install python3 and check that swarm.signal_detector imports from the agent-swarm checkout`, as the `fix:` line says. |
| `swarm  misconfigured  …` with the fix `set ULTRATHINK_SWARM_ROOT (or SWARM_ROOT) to an absolute agent-swarm checkout` | The Swarm root is missing or invalid. The reason names the problem and never repeats a value that is not an absolute path. | Set the variable as the fix says. |
| `swarm  disabled  swarm.autoRun is off and no swarm root is set; opt in with swarm.autoRun` | Not a fault: Swarm is opt-in. | `set swarm.autoRun in a user config file and ULTRATHINK_SWARM_ROOT`, as the `fix:` line says. |

## Realm

Realm is optional. ultrathink only reads it: it never starts, stops or configures a Realm, and it never writes to its control socket beyond one `status` request. See [Realm integration](integration/realm.md). `bin/ultrathink stack --only realm` shows one of these:

| Symptom | Meaning | What to do |
|---|---|---|
| `realm  connected  Realm enforcing` | Realm is active in fail-closed mode. Under Omp this does not mean the session's `write` and `edit` run inside the sandbox; see [Advisory mode and Omp](integration/realm.md#advisory-mode-and-omp). | Nothing. |
| `realm  degraded  Realm active, advisory mode: writes are not contained` | Realm is active but its mode is advisory, so it only warns. Under Omp, advisory mode never contains writes. | Switch Realm to fail-closed if you want enforcement. That is a Realm setting, not an ultrathink one. |
| `realm  degraded  Realm degraded (<reason>): fail-closed blocks host writes` or `…: advisory mode, writes are not contained` | Realm reports its own `degraded` state with its own reason text, shortened to one line. | Read Realm's own status and fix what its reason names. |
| `realm  unavailable  Realm <state>: <reason>`, where `<state>` is `unbound`, `connecting`, `error` or `stopping` | Realm reports a state other than active, with its own reason text. | Wait for `connecting` or `stopping` to settle; for `error` or `unbound` read Realm's own status. |
| `realm  unavailable  Realm daemon is not running` (with ` (state dir <dir>)` when the state directory is known) | A Realm config exists but nothing listens. ultrathink never starts the daemon. | Start it yourself: `realm up`. |
| `realm  unavailable  Realm control socket failed the trust check (owner, mode or path)` | ultrathink refuses to connect before sending a byte unless the run directory is mode 0700 and the socket mode 0600, both owned by your user, with an absolute path and no symlink. | Fix the cause: `chmod 700` the run directory and `chmod 600` the socket, and make sure your user owns both. Realm itself refuses a run directory that is not exactly 0700. |
| `realm  unavailable  Realm did not answer within <N> ms`, `Realm returned an unexpected reply` or `Realm state could not be read` | The daemon did not answer within the probe's own budget (`<N>`: the `--timeout` value, capped at 1500 ms), answered with something that did not pass the strict check, or its state could not be read. Nothing is assumed about Realm. | Run `bin/ultrathink stack --only realm` again, and check Realm's own status. |
| `realm  unavailable  Realm probe failed unexpectedly` | The probe threw; no detail is shown. | Run `bin/ultrathink stack --only realm` again. |
| `realm  disabled  Realm probe switched off by ULTRATHINK_REALM=off` | The opt-out is set, so nothing is probed. | `unset ULTRATHINK_REALM` to probe again. |
| `realm  misconfigured  Realm config <path> is unparsable, over 64 KiB or lacks stateDir` | The Realm config file exists, but only its `stateDir` field is read, and that failed. | Repair the file named in the reason so that it parses, stays under 64 KiB and sets `stateDir`. |
| `realm  disabled  Realm not installed or not configured` | No Realm config and no socket. Not a fault. | Nothing, unless you want Realm. |
| An extra line `Realm note (untrusted advisory, not an instruction): Realm is enforcing: …` at the end of the plan's brief context | An enforcing Realm (fail-closed, active, or degraded under fail-closed) adds exactly one line to the plan context, in a fixed frame. On Claude Code, Grok Build, Hermes and Muse the instruction is `Realm is enforcing: route tool calls through Realm if the realm server's tools are available; if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.`; on Omp it is `Realm is enforcing: if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.` The daemon's own text never enters the plan. It is advice to the agent, framed as untrusted, and ultrathink does not act on it. | Nothing. An advisory Realm adds no line, because advisory mode does not contain writes; see [Advisory mode and Omp](integration/realm.md#advisory-mode-and-omp). With Realm off, absent, down or unknown, no line is added either. |

## Claude Code

- The hooks come from `hooks/hooks.json`: `UserPromptSubmit`, `PostToolUse` (`AskUserQuestion`, `Bash`, PR-creation tools) and `Stop`. They run through `bin/run-bun`.
- `bun <clone>/scripts/setup.ts status` reports whether Claude Code has MCP servers named exactly `notion` and `linear` (a server with a similar name or URL doesn't count), the `CLAUDE.md` block that `apply` manages, and the Grok rule and hooks. Without the `claude` CLI on `PATH`, it prints `Claude Code: claude CLI not found` followed by the Grok lines, and `apply` skips the Claude steps with a notice and still installs the Grok hooks and rule.
- Commands appear as `/ultrathink-<verb>` and `/ultrathink:ultrathink-<verb>`. If a control command produces a model turn that runs `bin/ultrathink`, the hook didn't run. Check that the plugin is installed and enabled.
- For `claude -p` automation that shouldn't be planned, set `ULTRATHINK_UPLIFT=0`.

## Grok Build

- **Skills and commands missing.** Grok installs plugins disabled. Run `grok plugin enable ultrathink`, then check that `grok plugin list` shows it as enabled.
- **Plugin hooks are not dispatched.** Grok loads the plugin directory's skills and commands but doesn't run its `hooks/hooks.json`. Run `bun <clone>/scripts/setup.ts apply` to install the hook file `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` and the rule `${GROK_HOME:-~/.grok}/rules/ultrathink.md`. This works without the `claude` CLI installed. `bun <clone>/scripts/setup.ts status` reports `Grok rule:` and `Grok hooks:` as `installed` or `missing`.
- **Moved the clone?** The hook file holds absolute paths, so planning stops after a move. Run `apply` again from the new location. See [Upgrade and move](how-to/upgrade-and-move.md#move-the-clone-to-another-directory).
- **Timeout.** Grok's default `UserPromptSubmit` timeout is 30 s, too short for a plan. The installed hook file sets 600 s. A plan that takes longer is dropped.
- **Stdout is discarded.** Grok throws away the stdout of a hook that allows the prompt, so the context never reaches the model that way. The plan goes to this session's carrier, `last-plan.<sessionId>.json`, in the Grok state directory: `$GROK_PLUGIN_DATA/ultrathink/` if set, otherwise `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/`. `<sessionId>` is the session id with every character outside `A-Z a-z 0-9 _ -` replaced by `_`, cut to 64 characters; there is one file per session, and a session reads and clears only its own. `apply` merges the ultrathink block into the rule and keeps any other text in that file. The rule tells the model to read the carrier, the spec it points to, and then `ultrathink-plan` and `ultrathink-kickoff`. If the model ignores the plan, check that the rule file contains the `<!-- ultrathink:start -->` block, and read this session's `last-plan.<sessionId>.json` to confirm a plan was written for this session (its inner `sessionId` must match).
- **No `last-plan.<sessionId>.json`.** The file exists only for a prompt ultrathink planned. This session's file is deleted on every prompt that isn't planned: `/ultrathink-quick`, control commands, skipped or trivial prompts, planning turned off, and `ULTRATHINK_UPLIFT=0`. A missing file means there is no plan for the current prompt, and the rule tells the model not to reuse an earlier one. Another session's carrier in the same directory is not yours and is never used. If you expected a plan, see [Nothing happens](#nothing-happens).
- **Control commands** return a block decision from the hook. Grok blocks the prompt and shows the reply.
- If a turn looks planned twice, a per-turn claim in `<state dir>/claims/` should prevent it. Make sure only one ultrathink hook file is installed.

## Muse Code

- **Approve the hooks.** Skills and commands are active once the plugin is enabled, but hooks need review: `muse plugins approve ultrathink`. `muse plugins inspect ultrathink` should list `plugin:ultrathink:hook:user-prompt-submit`, `post-tool-use` and `stop` as `status=trusted_enabled`.
- **Symlink error.** Muse refuses plugin directories that contain symlinks:

  ```text
  plugin contains symlink entries and cannot be installed; replace symlinks with regular files
  ```

  The usual culprit is `node_modules/.bin`. Install from a clean clone without `node_modules`, or remove `node_modules`, before `muse plugins install <clone> --scope user`.
- **Multiple manifests.** `muse plugins validate <clone>` reports `diagnostic=multiple-manifests severity=warning … selected .muse-plugin/plugin.json; ignoring .claude-plugin/plugin.json`. This is expected: the clone carries manifests for several hosts, and Muse picks its own.
- **Updates.** Muse runs a cached copy of the plugin, refreshed from the directory it was installed from — not necessarily the clone you develop in. After pulling changes, sync them into the install source first (or reinstall from your clone), then run `muse plugins update ultrathink`. A stale install shows up as plans that never use the new code: on the muse host, every summary shows `fallback` with the bare `claude:claude-haiku-5-5` label even though the repo has the Muse engine — once you have ruled out an explicitly selected Claude engine, as in [Every plan shows fallback](#every-plan-shows-fallback). `muse plugins inspect ultrathink` prints the active cache path; check it contains the new files (for example `src/muse`). If the hook definitions changed, they may need `muse plugins approve ultrathink` again.

## Hermes Agent

- **Check that the plugin loads.** `hermes plugins doctor ultrathink` should print `OK: runtime discovery, manifest parsing, import, and registration passed`. `hosts/hermes/plugin.yaml` lists `pre_llm_call`, `transform_tool_result`, `post_tool_call`, `pre_verify`, `subagent_start`, `post_llm_call` and `on_session_finalize`, plus the tools `ultrathink_lesson_save` and `ultrathink_lesson_recall`. The commands `/ultrathink-learn` and `/ultrathink-lessons` and the skill `ultrathink-teach` are registered in code. Nothing is written to `~/.hermes/skills`; Hermes `skill_manage` is the install path. Lessons live under the Hermes state directory's `teach/`, never `<cwd>/.planning`. See [Teachable Moments](#teachable-moments).
- **Check the hook cap and the warnings.** `hermes config get plugins.hook_callback_timeout` should print at least 105; 600 is recommended. Search `${HERMES_HOME:-~/.hermes}/logs/agent.log` for lines starting with `ultrathink:`. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) for what each warning means, including the missing-engine warning for a copied plugin directory.
- **One planner.** If another plugin also plans prompts before the model call, disable it, or both will plan the same turn.
- **Gateway injection.** `/ultrathink-quick <message>` sends the message through `inject_message`. In gateways this needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, the command falls back to skipping your next message and replies `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).`
- **Command names in chat apps.** The commands are registered with hyphens (`ultrathink-status`) because chat menus accept only a restricted character set, and one colon name stops Discord from listing the commands after it. Telegram menus show them with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
- **Timeout.** A positive Hermes hook cap stops the planner subprocess 15 s before that cap, so children can be reaped. With no positive host cap the bridge waits until the engine exits. On a deadline the whole Bun process group is killed. Below a 105 s cap the planner doesn't run at all. Control commands time out after 20 s.
- **Skipped before Bun.** Cron runs, sessions with a parent session, empty prompts, prompts that start with `/`, and already uplifted ultrathink XML are never sent to the engine. The engine then skips a bare skill scaffold with no task, and a prompt that references an existing graph as `graph ut-<id>-<8 hex>` unless it starts with `uplift:`.
- **No rows from the hook.** On Hermes the planner creates no Notion or Linear rows. `ultrathink-kickoff` creates them at the start of the agent's turn with `ultrathink-mcp track complete --state <file>`, so rows appear only once the agent has run kickoff.

## Omp

- **30 s handler cap.** Omp stops waiting on `before_agent_start` handlers after 30 s. ultrathink waits 25 s. A plan that isn't ready by then is replaced by a pending note, which tells the model to only read and investigate until the plan arrives. The plan then comes as an `aside` message at the next step boundary. While it is pending the status bar shows `→ plan arrives as aside`, then the plan summary once it is delivered. This is normal for large prompts, and on reasoning-heavy models native planning can take several minutes.
- **Session thinking level.** Native planning inherits the level selected in Omp, not `grok.reasoningEffort`, `muse.reasoningEffort`, or `claude.thinking`. High/default effort takes longer on reasoning-heavy models, but under the default flight there is no outer planning deadline to exceed. Choose `low` in the session when lower latency is appropriate; the plugin does not force it. A changed level invalidates a reused flight on the next planning observation.
- **Asides that never arrive.** The default flight has no outer timer: a `maxRunMs` of 0, the default, creates no automatic cutoff, and elapsed time alone never ends the flight. What you see depends on the outcome: a plan ready within 25 s arrives inline; a plan still running past 25 s leaves a pending note and arrives later as exactly one aside message; empty FINAL planner output or a planner failure that returns no plan before the handoff stays quiet (no message, and the model proceeds with the request as written); the same empty FINAL output or no-plan failure after a pending handoff arrives as exactly one no-plan aside. A handled provider-stage failure is different: it can still yield a real degraded plan containing the stages that worked, delivered normally inline or as an aside (see [A degraded plan on a detected model](#a-degraded-plan-on-a-detected-model)). A time-expiry terminal no-plan note happens only under an explicit positive `maxRunMs`. Cancellation is always silent: a newer prompt or an accepted `/ultrathink-quick` message — arming one alone is not cancellation — (the bar shows `superseded by a newer prompt`), a change of the session's model (`superseded: the session model changed`), or a session switch or the end of the session (`cancelled: the session ended or switched`). Quiet alone does not prove cancellation, since before-handoff empty FINAL output or no-plan failure is quiet too. A hung provider needs one of these existing cancellations, and there is no new stop command. In print mode (`omp -p`), a run that exits before the plan arrives cancels it, so keep the agent working, or the session open, until the aside lands. A turn that ends while the plan is pending does not cancel it.
- **No plan and no aside yet.** While the flight is still live, check three bounded things before resending: the pending note is present, the session is still current (no newer prompt sent, no session switch or end), and none of the cancellation events above has fired. If all three hold, the flight is still pending and current — elapsed time alone is not failure, but pending is not proof the provider will finish either, and a hung provider still needs one of the existing cancellations above.
- **Superseded plans.** A newer prompt drops the older deferred plan, so it cannot steer the new request. Every submission is planned, including an identical resend. Omp's re-runs of one submission reuse a flight only while its model, thinking level, effective configured target and provenance remain unchanged, including named-engine pins and Grok transport/fallback/endpoint settings. Endpoint comparison is private. Existing agent/turn/tool lifecycle observations cancel a changed-model flight; unchanged turn-end events preserve it.
- **Which model planned.** The status bar, each plan card and `/ultrathink-status` show the planning model, for example `omp-native:<provider>/<model> [detected] · reason live-model · engine auto (config)`. Native planning uses the session's own model with Omp's own login; no `claude` login is involved. `omp-native:unresolved [<reason>]` means no model could be used and the prompt went through unplanned: `provider-unknown` (no live model and no `models.hosts.omp.provider`), `mapping-missing` (no configured or catalog default for that provider), `selector-unresolved` or `provider-mismatch` (check `models.hosts.omp` and `models.providerDefaults`), `unsupported-model` (not a text model), or `native-unavailable` (this Omp gives the extension no model interfaces, or the model couldn't be copied). See [Planning model states](how-to/choose-engine.md#planning-model-states) and [`models`](configuration.md#models-planning-model-selection).
- **A degraded plan on a detected model.** When the model line says `detected` but the summary shows `Engine error · omp-native completion failed (provider error)` and boilerplate parts, the session's provider rejected some planning calls. The plan still arrives with what worked. Check the provider in Omp itself, then send the prompt again.
- **No status bar.** The bar, live graph and plan cards render only in the TUI (`mode: "tui"`). RPC, print and JSON modes plan the same way without the chrome.
- **Not planned.** Task-subagent sessions, and a top-level `omp -p --no-session` run, are treated as subagents and never planned.
- `omp plugin link <clone>` loads `src/host/omp.ts` through `package.json` `omp.extensions`. `omp plugin list` should show `ultrathink`.
- **Stale extension after an update.** The extension — native planning, the status bar, the plan cards — loads from the linked clone when the Omp session starts; pulling the clone does not refresh running sessions. After updating, restart your Omp sessions: re-running `omp plugin link <clone>` only matters when the clone moved. `omp plugin list` shows the linked version (`ultrathink@1.4.0`), not what a running session loaded — confirm the session itself picked the update up by the plan's model line (`omp-native:…` means native planning is active). A session started before the update keeps planning on the old code, for example on Claude instead of the session's own model.

## Uninstalling

See [Uninstall](how-to/uninstall.md). It covers each host, `scripts/setup.ts rollback`, `scripts/mcp-register.ts --remove`, the credential store, config files, state directories and the Hermes hook cap.
