# Working without paid inference

ultrathink can run with no paid model access. Some steps keep working, some fall back to a reduced form, and a few stop with a message. This page lists which is which, the exact message for each stop, how the failover order works now, and the owner actions that remain.

Each capability has one class:

- **inference-free**: runs without any model call.
- **inference-optional**: uses a model when one answers. Without one, the step continues in a reduced form or with a rules-only result.
- **inference-required**: needs a model. Without one, it stops with the message shown in [section 2](#2-what-needs-a-paid-route).

## 1. What keeps working with no paid access

| Capability | Class | What you get without inference |
|---|---|---|
| Planning on Claude Code, Omp (auto or a named engine), Hermes, Cursor or Prime Agent | inference-optional | Uplift falls back to a labelled fallback spec. Graph of Thought degrades to boilerplate with no tracker rows. Chain-of-thought nodes are marked degraded. |
| Planning on the Muse route | inference-optional | No degraded output is documented for this route in the inventory; treat the no-model result as unconfirmed. |
| Planning on the Claude route with `claude.fallbackToGrok` on | inference-optional | Only the paid Grok legs are added. Without them, the Claude route is unchanged. |
| Jev plan gate | inference-optional | Any failure plans normally. |
| Ship judge | inference-optional | No judge gives the rules-only result `deterministic checks passed`. With `autoMerge` on, the result is not done, with `no judge available`. |
| Jev ship point | inference-optional | Fails open. |
| Ship review (Greptile) | inference-free | Needs a Greptile credential or the Greptile CLI. Without one, it is blocked with the `GREPTILE_SETUP` message. |
| Ship merge gate, `pr` and `status` | inference-free | Run without a model. |
| Ship `sync` | inference-free | Needs no tracker configured. With none, it stops silently. |
| Teach `status`, `list`, `show`, `confirm`, `forget` | inference-free | Run without a model. |
| Track and kickoff | inference-free | Linear and Notion. Notion needs its login. With no tracker configured, nothing is created. |
| `doctor`, `status`, `stack` | inference-free | Run without a model. |

## 2. What needs a paid route

| Capability | Class | What you see instead |
|---|---|---|
| Planning on the Grok route (`think.engine: "grok"`) | inference-required | The prompt goes through unplanned with ``Prompt Uplift skipped · Grok login required (run `grok login`)``. |
| Teach `observe` distiller | inference-required | Shown as `no engine` or `distiller failed`. Nothing is captured. |
| Grok Bot adapter | inference-required | Status `needs-model`. |
| Hosted service planning | inference-required | Start is refused as disabled or not_ready. |
| `grok check`, `decisions check` and `decisions probe` | inference-required | Explicit paid probes. They run only when you invoke them. |

The Grok login message is the one most users meet first. It means the Grok route has no signed-in, unexpired `grok login` session, so run `grok login` or choose another engine. See [Choose the engine](choose-engine.md).

## 3. How the fallback order works

The fallback applies only when `claude.fallbackToGrok` is on. A failed Claude call moves to the Grok candidates in this order:

1. The login-based Grok candidates, when a Grok login is usable.
2. The Grok shunt gateway, when `grok.shuntBaseUrl` is set. The shunt needs no login, and it is used when the primary transport is not `shunt`.

A refused or unreachable Grok gateway counts as a network failure, so the chain moves to the next candidate. The full list of failures that fail over is in [Configuration](../configuration.md#claude-and-grok-failover).

The ship judge follows the session's own provider:

- An xai session (for example `grok-4.7`) judges on the Grok route, through the shunt when it is configured, with Claude as the last resort.
- Other sessions judge on the host's default auxiliary route, which is Claude in Omp.

The `judgedBy` field in ship output names the provider that answered.

Memory distillation does not follow these keys. It is pinned by the owner to Claude Haiku 5.5, then Grok Build with a Grok login only. The shunt is never used there, and no setting changes that.

## 4. Owner actions that remain

- **A Grok login, for memory distillation.** Run `grok login`. Grok Build is the second leg of the distiller. That leg also needs `claude.fallbackToGrok` on, `grok.enabled` on, and a `grok.transport` other than `shunt`. See [Configuration](../configuration.md#claude-and-grok-failover).
- **A Greptile credential, for review.** Store a key with `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install the Greptile CLI and run `greptile login`. See [Ship with Greptile](ship-with-greptile.md).
- **An OpenRouter key, only if you want Jev.** Jev is always on in config. Only a configured key activates it. Store one with `bin/ultrathink-mcp auth set-key openrouter --stdin`. An OpenRouter credits or auth failure opens a persisted breaker: a 5-minute cool-down that doubles up to 6 hours. While it is open, no request is made. See [Use Jev decisions](use-jev-decisions.md).

To see which of these states apply to your install, run the checks in [Diagnose with doctor](diagnose-with-doctor.md).
