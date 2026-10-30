# Choose the planning engine

The **engine** is the model ultrathink calls to plan a prompt. It writes the spec, the Graph of Thought (a small graph of reasoning steps that ends in an execution plan) and the clarifying questions. When ship is on, a CLI engine is also the judge that decides whether a task is done. The **host** is the coding agent you type into (Claude Code, Grok Build, Hermes Agent, Muse Code, Omp, Prime Agent or Cursor). The host keeps its own model for the actual work. The engine is separate: Claude, Grok or Muse on any host, or, on Omp, the session's own model. By default Claude Code, Prime Agent and Cursor plan with Claude, Grok Build with Grok, Muse Code with Muse, Hermes with the engine of its session model's family (Claude when the family is unknown), and Omp natively with the session's own live model.

- [Claude](#claude)
- [Grok](#grok)
- [The Grok model walk](#the-grok-model-walk)
- [Claude to Grok fallback](#claude-to-grok-fallback)
- [Grok Build login lane](#grok-build-login-lane)
- [Memory-bank chain](#memory-bank-chain)
- [Muse](#muse)
- [Omp: the session's own model](#omp-the-sessions-own-model)
- [Switch engines](#switch-engines)
- [Check which engine is active](#check-which-engine-is-active)
- [Planning model states](#planning-model-states)
- [When the engine fails](#when-the-engine-fails)
- [Verified models](#verified-models)

## Claude

ultrathink runs the Claude Code CLI headless (`claude -p`) for every planning call on the hosts whose engine resolves to Claude: Claude Code by default, Hermes when the session model is a Claude model or of an unknown family, Omp and every other host with `think.engine` set to `"claude"`, and a Grok route that one of the two Grok switches below hands to Claude. On Omp under `auto` it also runs the ship done check and the Teachable Moments distiller, which never use the session's model. Each call is a plain completion: no tools, no MCP servers and no settings sources, and it runs with `ULTRATHINK_CHILD=1` so the prompt hook never plans ultrathink's own calls.

**Plan-first auth.** Claude is the primary engine and it runs on the plan login of the person who owns the machine: the `claude` CLI signed in with your own Claude plan (Pro or Max). Anthropic documents that with a plan login, `claude -p` still draws from your subscription limits (the 5-hour session and the weekly limit). The monthly API credits that Max and Team plans include do **not** cover plan-login `claude -p`. The plan is for its holder's own use: Anthropic does not permit routing other people's requests through plan credentials, so never put a plan login behind a multi-user service. ultrathink reads no credential out of the CLI's store; it only runs the CLI.

Claude Code ranks credentials, and an `ANTHROPIC_API_KEY` in the environment outranks a plan login in `-p` mode (see "Authentication precedence" in the [Claude Code docs](https://code.claude.com/docs/en/authentication)). A stale or empty-balance key then fails every call with `Credit balance is too low`. So with `claude.auth: "plan"` (the default) ultrathink starts the child without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`, and the plan login authenticates. Your shell is not changed: an interactive `claude` still uses the key. `claude.auth: "api-key"` passes the environment through unchanged, for people who really use an API key. Only the user config file can set `claude.auth`.

For headless machines, run `claude setup-token` once and export the one-year token it prints as `CLAUDE_CODE_OAUTH_TOKEN`; it bills to your plan and the child honors it.

You need:

- the `claude` CLI on `PATH` (or its path in `claude.bin`), at least version 2.1.293 for the default model (`claude update` upgrades it);
- a plan login for it (run `claude` and sign in with `/login`), or `CLAUDE_CODE_OAUTH_TOKEN`. The calls count against your plan's limits. When a limit is hit, see the [Claude to Grok fallback](#claude-to-grok-fallback).

| Key | Default | Meaning |
|---|---|---|
| `claude.model` | `"claude-haiku-5-5"` | Model passed as `--model`. `""` uses the CLI's own default model. The built-in value comes from the [route-default map](../configuration.md#route-defaults). |
| `claude.auth` | `"plan"` | `"plan"` runs the child on the plan login and ignores the key variables above; `"api-key"` passes the environment through. User config only. |
| `claude.fallbackToGrok` | `false` | Fail a failed Claude call over to the Grok route. User config only. See [Claude to Grok fallback](#claude-to-grok-fallback). |
| `claude.bin` | `"claude"` | Binary to run. |
| `claude.thinking` | `false` | Allow extended thinking in the planning calls. Off sets `MAX_THINKING_TOKENS=0` for the child, which is much faster. |
| `claude.settingSources` | `""` | `--setting-sources` for the child. Empty loads none: fastest, and no nested hooks. |
| `claude.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer; the host's hook timeout still applies. |

The `Engine:` line of `bin/ultrathink status` shows `claude:<model>`, for example `claude:claude-haiku-5-5`, or `claude:session default` when `claude.model` is `""`. The `Claude:` line shows the model, the auth mode and whether the Grok fallback is on. The plan's model line shows how the model was chosen: `claude:claude-haiku-5-5 [route default]` for the built-in model, `claude:<model> [override]` for a model set in a config file (an old `claude.model` pin such as `"claude-sonnet-5-5"` keeps winning until you remove it), and `claude:CLI default (model unobserved)` for `""`. The removed `claude.fallbackToLogin` key is ignored if it is still in a config file.

## Grok

Grok Build plans with Grok by default (`grok-build-0.1`, with no reasoning effort). The entitlement for it belongs to one xAI account, so the login must be that account's; see [Grok Build login lane](#grok-build-login-lane). Set `think.engine` to `"grok"` to plan with Grok on every host. `grok.enabled` (default `true`) must stay `true`; `false` forces Claude even when Grok is selected.

Grok has two **transports**, the ways ultrathink reaches the model:

| `grok.transport` | What ultrathink does | What you need |
|---|---|---|
| `"http"` (default) | `POST {grok.baseUrl}/responses`, default base `https://cli-chat-proxy.grok.com/v1` | The Grok Build CLI (`grok`) signed in with `grok login`. ultrathink reads that session from `auth.json` in the Grok home. |
| `"cli"` | Runs the `grok` binary headless for one turn in a private temporary directory, with tools, web search and subagents turned off | The same `grok login` session. |

For `http` and `cli`:

- The Grok home is `grok.home` (user config only), else `$GROK_HOME`, else `~/.grok`. For a dedicated login, see [Grok Build login lane](#grok-build-login-lane).
- `bin/ultrathink status` calls this session "SuperGrok OAuth". You need a Grok account that can sign in to the Grok Build CLI.
- When the session has expired and has a refresh token, ultrathink runs `grok models` once so the CLI refreshes it. ultrathink never calls the token endpoint itself.
- Before planning, ultrathink checks the login. If it is missing or expired, the prompt goes through unplanned with the reason ``Prompt Uplift skipped · Grok login required (run `grok login`)``, which the Claude Code, Grok Build and Muse Code hook shows for a plain prompt. That is the same under `auto` on Grok Build and with `think.engine: "grok"`; the record says `grok:unresolved [grok-unavailable]`.
- Claude replaces a selected Grok route only through the two explicit, labeled user switches: `grok.fallbackToClaude: true` (HTTP/CLI login missing or expired) and `grok.enabled: false` (documented ‘forces Claude even when Grok is selected’). Without them, a missing or expired Grok login skips planning with the unchanged `GROK_LOGIN_REQUIRED` notice. Naming `think.engine: "claude"` is a deliberate engine choice, not a replacement.
- With either switch, Claude plans on its own `claude.model`, never on the Grok model, and the plan's model line reads `claude:<model> [configured fallback · grok unavailable]`.

| Key | Default | Meaning |
|---|---|---|
| `grok.model` | `"grok-build-0.1"` | First model for `http` and `cli`. |
| `grok.fallbackModels` | `[]` | Models tried, in order, after `grok.model` when the session cannot use it. Empty by default: `grok-4.7` is never a default. See [the model walk](#the-grok-model-walk). |
| `grok.reasoningEffort` | `"xhigh"` | `"low"`, `"medium"`, `"high"` or `"xhigh"`. Used by `http` and `cli`, and sent only to `grok-4.5`, `grok-4.6` and `grok-4.7`, the models xAI documents it for (`grok-4.5` treats `xhigh` as `high`). Other models, including `grok-build-0.1`, get no effort and no `@<effort>` in their label. |
| `grok.baseUrl` | `"https://cli-chat-proxy.grok.com/v1"` | Endpoint for `http`. |
| `grok.bin` | `"grok"` | Grok CLI binary, for `cli` and for the session refresh. |
| `grok.home` | `""` | Grok home; empty uses `$GROK_HOME`, else `~/.grok`. User config only. See [Grok Build login lane](#grok-build-login-lane). |
| `grok.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer. |
| `grok.fallbackToClaude` | `false` | Plan on Claude when the Grok login is missing or expired. |

The `Engine:` status label is `<model>@<effort>` for `http` and `cli` when the model takes an effort (for example `grok-4.7@xhigh`), just `<model>` when it does not (`grok-build-0.1`). The plan's model line reads, for example, `grok:grok-build-0.1 [route default]`.

## The Grok model walk

When you list models in `grok.fallbackModels`, the `http` and `cli` transports try `grok.model` first and then each listed model, in order, and skip a model your session cannot use. The default list is empty. A model counts as unusable when the proxy answers HTTP 429 with a request limit of 0, HTTP 403 `requires a Grok subscription`, or the CLI reports `unknown model id`. Within one planning run such a model rests for 60 minutes, so the later stage calls of that run do not try it again; the next prompt tries it once more. Other failures that fail over use the rest times [below](#claude-to-grok-fallback).

`grok-build-0.1`, the default, is entitled per xAI account (see [Verified models](#verified-models)). When the login belongs to an account without it, xAI answers HTTP 429 with a request limit of 0. With the default empty `grok.fallbackModels` the Grok route reports that failure as an `Engine error · …`, and the fix is the right login ([Grok Build login lane](#grok-build-login-lane)), not a pricier model. To walk on to another model, list it yourself, for example `["grok-4.7"]`; `grok-4.7` is never a default. A project config file may set `grok.fallbackModels`, like `grok.model`.

## Grok Build login lane

The Grok Build entitlement (`grok-build-0.1`) is per xAI account. The Grok CLI's default login (`~/.grok`) may belong to another account than the one that holds it, and that login then gets HTTP 429 with a request limit of 0. xAI also rotates the refresh token on every refresh and retires the old one, so two applications must never share one login. ultrathink therefore uses its own login for the entitled account, in its own Grok home, and never reads another application's auth store.

```sh
<clone>/bin/ultrathink grok login [--home <dir>] [--write-config]
<clone>/bin/ultrathink grok check [--model <id>] [--transport http|cli] [--json]
```

- `grok login` runs the official `grok login --device-auth` with `GROK_HOME=<home>`, then verifies the login. The default home is `~/.config/ultrathink/grok` (under `$XDG_CONFIG_HOME` when that is set); `--home` must be an absolute path. It creates the home with mode `0700`, never touches `~/.grok`, and removes `XAI_API_KEY` from the login child's environment so the login is the plan login. Sign in as the xAI account that holds Grok Build.
- `--write-config` sets `grok.home` in your user config: in the user file that already sets `grok.home` (the Claude user file `~/.claude/ultrathink.json` outranks `~/.config/ultrathink/config.json`), or in `~/.config/ultrathink/config.json` when none does. It prints the file it wrote, and warns and exits 1 if another user file still overrides the value. Without it, `grok login` prints the snippet `{"grok":{"home":"<dir>"}}` to add yourself.
- `grok check` runs a one-word probe (capped at 16 output tokens on the HTTP route) through the Grok route as configured, and with `--model` or `--transport` through the one you name. It prints `Grok check: ok · <model> · …` or `Grok check: error (<class>) · … · fix: …`, and exits 0 or 1. `--json` prints the same fields as JSON.
- `grok.home` is read from user config only; a project file cannot set it.

Omp has an alternative, `omp auth-gateway`, which keeps omp as the one that refreshes the token. ultrathink does not use it. It presents the Claude Max OAuth token from a third-party harness, and Anthropic's [terms](https://code.claude.com/docs/en/legal-and-compliance) (retrieved 2026-10-28) restrict that: they do not permit third-party developers to route requests through Free, Pro or Max plan credentials on behalf of their users, and tell developers to use API key authentication. The official `claude` and `grok` CLIs, each signed in by the plan holder, are the supported route.

## Memory-bank chain

Memory-bank inference is the local `teach observe` distill that turns a session into lessons. It always runs `claude-haiku-5-5` first and, only with `claude.fallbackToGrok` on and the Grok lane signed in, `grok-build-0.1` second. The chain is pinned in code (`src/host/memory-chain.ts`) on purpose:

- `claude.model`, `grok.model`, `grok.fallbackModels`, `think.engine` and `models.hosts.<host>.model` overrides do not apply to it.
- Sonnet and `grok-4.7` are unreachable from it, whatever those keys say. A chain that would include any other model fails closed instead of running.
- Jev verdicts on lessons are separate calls to Jev and do not use this chain.
- **It needs the `claude` CLI, Claude Code 2.1.293 or newer** (the minimum for Haiku 5.5). There is no direct-HTTP route in the chain. A user with no CLI, and no Grok fallback that is on and signed in, gets `distiller failed`: `teach observe` stores nothing for that turn.
- **The API-key route still goes through the CLI.** Set `claude.auth: "api-key"` and export `ANTHROPIC_API_KEY`: the distill then runs `claude -p` with that key instead of the plan login. It does not bypass the CLI requirement.

`bin/ultrathink doctor` shows the chain as `inference.memory`: `Memory-bank inference: claude-haiku-5-5, then grok-build-0.1`, or `… claude-haiku-5-5 only` with the reason in the detail, and it names any configured model that is ignored here. While the distill is active (`teach.enabled` on, `ULTRATHINK_TEACH` not `0`, `teach.capture` not `explicit`), a missing `claude` CLI is a warning (`inference.claude.cli`) whose detail says the memory-bank distill needs it too. Hindsight itself needs no inference; see [Connect Hindsight](connect-hindsight.md).

## Claude to Grok fallback

By default a failed Claude call is an engine error. Set `claude.fallbackToGrok: true` in your **user** config (a project file cannot set it) and a failed Claude call fails over to the Grok route instead, trying `grok.model` and then `grok.fallbackModels`. It is off by default because the prompt text then leaves Anthropic for xAI; see [Privacy](../privacy.md). It applies only while the Grok route is usable, meaning a Grok login that is present and not expired.

These failure classes fail over: `auth`, `billing`, `plan-limit`, `rate-limit`, `overloaded`, `model-unavailable`, `unavailable`, `network` and `timeout`. `aborted` and `other` do not; they stop the call as before. Within one planning run, a candidate that failed is not retried on every stage call; it rests for the time below. When every candidate is resting, nothing is invoked: the call fails at once with the same failure, and once the rests lapse only one resting candidate is probed per call. The rests are kept in `<state dir>/failover-cooldowns.json`, so a hook process, which builds a new chain for each prompt, starts with the rests that earlier processes found instead of walking an exhausted candidate again; an unreadable or missing file means no rests.

| Class | Rest within one run | Typical cause |
|---|---|---|
| `auth` | 10 min | Claude or Grok login missing, expired or rejected. |
| `billing` | 60 min | `Credit balance is too low`. |
| `plan-limit` | 15 min | `You've hit your session limit`, or the weekly, Opus or Sonnet limit. |
| `rate-limit` | 60 s | HTTP 429 or `Server is temporarily limiting requests`. |
| `overloaded` | 30 s | HTTP 529, 500 or 503. |
| `model-unavailable` | 60 min | The model is not served to this session, or the CLI is too old for it. |
| `unavailable` | 60 min | The CLI binary is missing. |
| `network` | 30 s | `fetch failed`, `ECONNRESET`, a DNS failure, or resource exhaustion on the host (`EAGAIN`, `ENOMEM`, `EMFILE`, a child killed or `exited 137`). |
| `timeout` | 30 s | A call that ran past its timeout (`claude.callTimeoutMs` and the like), or HTTP 408. |

Before a failure is classified, a transient one (HTTP 408, 425, 429, 5xx, a network, overload or usage-limit error, a reply cut off at the token limit) is retried on the same candidate: three attempts with jittered backoff that honours `Retry-After`, never another model. Only the failure that remains is classified, fails over and rests the candidate for the time above. The summary line then carries `Failover · claude:claude-haiku-5-5 → grok:grok-build-0.1 (plan-limit)`, and the session record stores the same text as `engineFailover`.

## Muse

Muse Code plans with Muse by default (`muse-spark-1.3-contributor` at `high` reasoning effort). Set `think.engine` to `"muse"` to plan with Muse on every host.

ultrathink runs the `muse` CLI headless (`muse exec --json`) for one agent turn per planning call, with the shell, file writes and web tools disabled, and with `ULTRATHINK_CHILD=1` so the prompt hook never plans ultrathink's own calls.

You need:

- the `muse` CLI on `PATH` (or its path in `muse.bin`);
- a working login for it. ultrathink uses whatever login the CLI already has. The calls count against that account.

| Key | Default | Meaning |
|---|---|---|
| `muse.model` | `"muse-spark-1.3-contributor"` | Model id passed as `--model`. `""` omits the flag and the CLI's session default answers. |
| `muse.reasoningEffort` | `"high"` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` or `"ultra"`, passed as `--reasoning-effort`. |
| `muse.bin` | `"muse"` | Binary to run. |
| `muse.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer. |

The `Engine:` status label is `muse:<model>`, for example `muse:muse-spark-1.3-contributor`, or `muse:session default` when `muse.model` is `""`. The plan's model line reads, for example, `muse:muse-spark-1.3-contributor [route default]`.

## Omp: the session's own model

On Omp with `think.engine: "auto"` (the default), ultrathink plans inside Omp on the model your session is using. For each prompt it reads the session's current model once, copies it, and sends the uplift, the graph, every node fill and the clarifying questions to that copy through Omp's own completion call, with Omp's own provider and login.

- **No extra login.** Native planning needs no `claude`, `grok` or `muse` CLI and no separate login, and ultrathink copies no credential out of Omp. Only the text of each answer is used; the planning calls run no tools.
- **Other models.** `models.hosts.omp.model` plans with another model Omp knows, and `models.hosts.omp.provider` requires one provider. When the live model can't be used, the provider's default from `models.providerDefaults`, else Omp's installed catalog, is used. See [Configuration: `models`](../configuration.md#models-planning-model-selection).
- **Opting out.** A named engine (`think.engine: "claude"`, `"grok"` or `"muse"`, or `ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine claude`) plans on that CLI route as on any other host. The status then shows `native opt-out`.
- **Thinking level.** Every native stage inherits the session's captured thinking level. `off` uses Omp's reasoning-disable convention; `inherit` or an unavailable setting leaves provider defaults alone. For lower latency, explicitly choose a lower session level; ultrathink never lowers it silently. Named CLI engines retain their own effort settings.
- **Timing.** On reasoning-heavy models a native plan can take several minutes. The default flight has no outer planning deadline: an omitted or zero factory deadline creates no outer timer and no automatic cutoff. Omp waits 25 s; after that the agent gets a note to only read and investigate, and the plan arrives later as exactly one aside message. The 25-second wait is delivery-only: elapsed time never lowers effort, changes route, retries, or admits another model call.
- **Cancellation.** A plan is cancelled and never delivered when you send a newer prompt or an accepted `/ultrathink-quick` message (arming one alone is not cancellation), when a changed session model is observed at a planning call, existing agent/turn/tool lifecycle event or delivery, when a changed thinking level or effective target invalidates reentry, or when you switch or end the session. A hung provider needs one of these existing cancellations, and there is no new stop command. Provider failure or empty output still degrades fail-open. An explicit positive factory deadline is separately opt-in with terminal no-plan semantics. A print-mode run (`omp -p`) that exits early cancels its plan. An unchanged turn ending while the plan is pending does not.
- **Helpers stay on CLI routes.** The ship done check and the Teachable Moments distiller run outside the planning flight, so they use the Claude CLI route under `auto` (or the named engine), never the session's model.

## Switch engines

There are two layers, and the first beats the second:

1. **Per host**, stored in that host's state directory:

   ```sh
   <clone>/bin/ultrathink grok engine grok     # this host now plans with Grok
   <clone>/bin/ultrathink grok engine muse     # this host now plans with Muse
   <clone>/bin/ultrathink grok engine auto     # back to this host's own engine
   ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine grok   # another host's setting
   ```

   `<clone>` is the directory you cloned ultrathink into. Without `ULTRATHINK_HOST`, `bin/ultrathink` changes the host it detects from the environment, and Claude Code from a plain shell. `ULTRATHINK_HOST` takes `claude-code`, `grok-build`, `hermes`, `muse` or `omp`.

2. **Every host**, in a config file (see [Team and project config](team-and-project-config.md) for which file):

   ```json
   { "think": { "engine": "grok" } }
   ```

A host with no stored control engine follows `think.engine`. A stored control choice, including `auto`, takes precedence over that config value: explicitly choosing `auto` restores that host's automatic route. Automatic routes are Claude on Claude Code, Grok on Grok Build, Muse on Muse Code, the session model's family route on Hermes (Claude when unknown), and the session's own live model on Omp. A named engine on Omp opts out of native planning.

## Check which engine is active

```sh
<clone>/bin/ultrathink grok
```

It prints four lines, for example:

```text
Engine: grok-build-0.1
Claude: claude-haiku-5-5 · auth plan · fallback to Grok off
Grok: grok-build-0.1 · transport http
SuperGrok OAuth: you@example.com · expires 2026-10-01T12:00:00.000Z
```

`bin/ultrathink status` shows the same lines among the rest of the state, plus `Engine request: <engine> (<config or control>[, native opt-out]) · concurrency <n>` and, after a plan, `Last planned resolution:` with that plan's model line.

On Omp, `/ultrathink-status` shows the latest model the session planned with as the `Engine:` line, for example `omp-native:<provider>/<model> [detected]`. Before the first plan, and from a shell (`ULTRATHINK_HOST=omp <clone>/bin/ultrathink status`), which can't see the live session, it reads `omp-native:auto (live model not observed)`. The status bar and each plan card show the same model line.

## Planning model states

Every selection records one of four states, with the source and the reason. The record appears in the summary line, in the plan's `Planning model:` line, in the session record, in `Last planned resolution:`, and on Omp in the status bar, the plan cards and `/ultrathink-status`. It never contains an endpoint, a header or a credential.

| State | Meaning | Example labels |
|---|---|---|
| `detected` | Omp's live session model, used as it is. | `omp-native:<provider>/<model> [detected]` |
| `default` | A default chose the model: a CLI route's built-in model, the CLI's own default after `""`, the configured or catalog default for the live model's provider on Omp, or Claude through one of the two Grok switches. | `claude:claude-haiku-5-5 [route default]`, `claude:CLI default (model unobserved)`, `omp-native:<provider>/<model> [configured default]`, `omp-native:<provider>/<model> [host-catalog default]`, `claude:claude-haiku-5-5 [configured fallback · grok unavailable]` |
| `override` | You chose it: a model key set in a config file, `models.hosts.<host>.model`, or an Omp provider constraint that picked that provider's default (the record's `defaultSource` then names `configured-default` or `host-catalog`). | `claude:opus [override]`, `omp-native:<provider>/<model> [override]` |
| `unresolved` | No model could be used. The prompt goes through unplanned with the reason. | `omp-native:unresolved [provider-unknown]`, `grok:unresolved [grok-unavailable]` |

The reasons:

| Reason | Meaning |
|---|---|
| `live-model` | Omp's live model was used. |
| `active-unavailable` | Omp's live model couldn't be used, so its provider's default was. |
| `explicit-model`, `explicit-provider` | A model you set, or an Omp provider constraint. |
| `route-default-model` | A CLI route's built-in model from the route-default map. |
| `cli-delegation` | `claude.model` or `muse.model` is `""`, so the CLI chose. |
| `grok-unavailable` | The Grok login is missing or expired, so the prompt is skipped; or Claude plans in Grok's place through `grok.fallbackToClaude` or `grok.enabled: false`. |
| `native-unavailable` | Omp planning under `auto` ran without Omp's model interfaces, for example `hooks/engine.ts` called with `host: "omp"`. |
| `provider-unknown` | Omp has no live model and no `models.hosts.omp.provider` is set. |
| `mapping-missing` | No configured or catalog default exists for the provider. |
| `selector-unresolved` | Omp could not resolve the model you set, or the default, to a usable model. |
| `provider-mismatch` | The model resolved to another provider than required. |
| `unsupported-model` | The model can't do a plain text completion. |
| `selector-invalid` | A configured model or provider contains a control character. |
| `transport-incompatible` | A provider is set for a CLI route, which can't bind one. |
| `concrete-model-required` | The Grok route has no model to send. |
| `unsupported-host` | `hooks/engine.ts` was given a host it doesn't support, such as a bot name. |

The record shows the selection, not that the calls worked. A `detected` model whose calls fail keeps its state; the failure shows as `Engine error · …` and degraded stages, as below.

## When the engine fails

A failed or timed-out planning call never blocks your prompt. If the spec call fails, the turn goes on with a minimal fallback spec and creates no tracking rows, and the summary line reports `Engine error · …`. If the graph call fails, a built-in five-node graph is used, and no tracking rows are created from it. A node whose detail call fails is retried, repaired once, and then marked degraded: it carries no conclusion, and the plan's `## Planning degraded` notice names it. A failed clarification call is reported the same way (`clarify`) and asks no questions. See [Troubleshooting](../troubleshooting.md#planning-degraded) and [Reduce cost and latency](reduce-cost-and-latency.md) for the timeouts.

A failover is not an error. When [Claude fails over to Grok](#claude-to-grok-fallback) or the Grok route [moves to a model you listed in `grok.fallbackModels`](#the-grok-model-walk) and a later candidate answers, the plan is complete. The summary shows `Failover · <first> → <answering> (<failure class>)` and the session record keeps it as `engineFailover`. `Engine error · …` appears only when every candidate failed.

For every engine key, see [Configuration](../configuration.md#key-reference). For what each engine sends off your machine, see [Privacy](../privacy.md).

## Verified models

The built-in defaults were checked against the vendors' documentation and live sessions on 2026-10-27 and 2026-10-28.

| Model | Facts | Source |
|---|---|---|
| `claude-haiku-5-5` | Claude Haiku 5.5, released 2026-10-07, a dateless id that does not drift. Needs Claude Code 2.1.293 or newer. | [platform.claude.com/docs/en/models/overview](https://platform.claude.com/docs/en/models/overview) |
| `grok-build-0.1` | Grok Build 0.1, 256k context, aliases `grok-code-fast-1` and `grok-code-fast`. The entitlement belongs to one xAI account: on 2026-10-28 a login on an account without it got HTTP 429 with a request limit of 0, while a login on the entitled account answered. The fix is the right login (see [Grok Build login lane](#grok-build-login-lane)), not another model. | [docs.x.ai/developers/models/grok-build-0.1](https://docs.x.ai/developers/models/grok-build-0.1) |
| `grok-4.7` | Supports reasoning effort (`xhigh` from `grok-4.6` on; xAI documents the effort for `grok-4.5`, `grok-4.6` and `grok-4.7` only). Never a default: add it to `grok.fallbackModels` yourself if you want it. | [docs.x.ai/developers/models](https://docs.x.ai/developers/models) |

**Compliance.** The Grok `http` transport reuses the Grok Build login token against the Grok CLI's chat proxy. That is not an xAI-documented integration. The documented alternatives are the `cli` transport (`grok -p`) or an `XAI_API_KEY`.
