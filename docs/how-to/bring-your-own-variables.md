# Bring your own variables

ultrathink runs in three shapes, and each reads a different set of variables from a different place. This guide says where your own values go for each shape and tables the variables the code reads. It does not repeat the full generated reference: for every variable, its aliases, what it accepts and which are secrets, see the [environment reference](../environment.md).

The three shapes:

| Shape | What it is | Where your variables go |
|---|---|---|
| Plugin on a host | Claude Code, Grok Build, Hermes, Muse, Omp or Cursor runs the hooks and commands in this repository. | The agent's own environment, plus the config files and the credential store ([Configuration](../configuration.md)). |
| Stdio connector | `bin/ultrathink-connector`, started by a chat client as a process. | The `env` block of the client's MCP entry. Nothing else is read. |
| Self-hosted service | `services/ultrathink/server.ts` behind your own origin. | An env file the service manager or your shell loads ([Self-host](self-host.md)). |

**What is not provided.** The hosted service is single-tenant: one owner password, one Claude plan login, Jev decisions off. A multi-user hosted service with per-user keys, accounts or billing does not exist and is not planned here. Other people use ultrathink by running their own plugin, stdio connector or instance with their own variables, as this guide describes.

## Stdio connector

Source: `services/ultrathink/stdio/main.ts`, `src/host/detect.ts`, `src/host/paths.ts` and `bin/run-bun`. The connector reads no config file, no credential store and no `.env` file, and makes no network call. Set these in the `env` block of the client's MCP entry; the copy-paste entries are in [Copy-paste configs by client](use-ultrathink-in-chat.md#copy-paste-configs-by-client).

| Variable | Secret | Scope | Where read | Default |
|---|---|---|---|---|
| `ULTRATHINK_STATE_DIR` | no | the connector process | `services/ultrathink/stdio/main.ts` | `connector` directory under the host state directory; a path inside a `.planning` tree is ignored |
| `ULTRATHINK_LOG_LEVEL` | no | the connector process | `services/ultrathink/stdio/main.ts` | `warn` (`info`, `warn` or `error`) |
| `ULTRATHINK_HOST` | no | the connector process | `src/host/detect.ts` | detected from the markers below; Claude Code when none |
| `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, `GROK_SESSION_ID` | no | set by the host | `src/host/detect.ts` | unset |
| `MUSE_TOOL_USE_ID`, `MUSE_PLUGIN_ID` | no | set by the host | `src/host/detect.ts` | unset |
| `PRIME_AGENT_CODING_AGENT_DIR`, `RLM_SESSION_DIR` | no | set by the host | `src/host/detect.ts` | unset |
| `HOME`, `CLAUDE_CONFIG_DIR`, `GROK_PLUGIN_DATA`, `GROK_HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` | no | the client's environment | `src/host/paths.ts` | per host; used only when `ULTRATHINK_STATE_DIR` is unset |
| `BUN`, `BUN_INSTALL`, `PATH` | no | the client's environment | `bin/run-bun` | search order in [Finding Bun](../configuration.md#finding-bun) |

## Self-hosted service

Source: `services/ultrathink/config/config.ts`. The service reads its variables once at start and stops with the variable's name when one is invalid. Put them in an env file with mode 0600. Secrets are never to be echoed, committed or placed on a command line; the argon2id hash needs special care with `$` (see [Self-host](self-host.md#2-set-the-three-required-variables)). The `Default` column says `required` where the service will not start without it.

| Variable | Secret | Scope | Where read | Default |
|---|---|---|---|---|
| `ULTRATHINK_PUBLIC_ORIGIN` | no | service env file | `config.ts` | required |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | yes | service env file | `config.ts` | required |
| `ULTRATHINK_SESSION_SECRET` | yes | service env file | `config.ts` | required |
| `ULTRATHINK_SESSION_SECRET_PREVIOUS` | yes | service env file | `config.ts` | unset |
| `ULTRATHINK_CONNECTOR_KEY` | yes | service env file | `config.ts` | unset |
| `ULTRATHINK_TLS_CERT` | no (path) | service env file | `config.ts` | unset; all three TLS variables or none |
| `ULTRATHINK_TLS_KEY` | no (path to a private key) | service env file | `config.ts` | unset; all three TLS variables or none |
| `ULTRATHINK_TLS_CLIENT_CA` | no (path) | service env file | `config.ts` | unset; all three TLS variables or none |
| `ULTRATHINK_PLAINTEXT_LOOPBACK` | no | service env file | `config.ts` | `0`; `1` for development and smoke only |
| `ULTRATHINK_SPIFFE_TRUST_DOMAIN` | no | service env file | `config.ts` | `ultrathink.internal` |
| `ULTRATHINK_STATE_DIR` | no | service env file | `config.ts` | `/var/lib/ultrathink` |
| `ULTRATHINK_PORT` | no | service env file | `config.ts` | `8795` |
| `ULTRATHINK_ALLOWED_ORIGINS` | no | service env file | `config.ts` | none |
| `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` | no | service env file | `config.ts` | none |
| `ULTRATHINK_SERVER_PLANNING` | no | service env file | `config.ts` | unset (off); `1` turns planning on |
| `ULTRATHINK_PLANNING_MODEL` | no | service env file | `config.ts` | `claude-haiku-5-5` |
| `ULTRATHINK_PLANNING_FALLBACK` | no | service env file | `config.ts` | `none` (`none` or `grok`) |
| `ULTRATHINK_PLAN_CONCURRENCY` | no | service env file | `config.ts` | `2` |
| `ULTRATHINK_MAX_CONCURRENT_PLANS` | no | service env file | `config.ts` | `2` |
| `ULTRATHINK_MODEL_TIMEOUT_MS` | no | service env file | `config.ts` | `0` (none) |
| `ULTRATHINK_PLAN_TIMEOUT_MS` | no | service env file | `config.ts` | `0` (none) |
| `ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS` | no | service env file | `config.ts` | `0` (no configured cap) |
| `ULTRATHINK_MAX_INPUT_CHARS` | no | service env file | `config.ts` | `4000000` (`0` means no limit) |
| `ULTRATHINK_MAX_ANSWER_CHARS` | no | service env file | `config.ts` | `20000` |
| `ULTRATHINK_RUN_TOKEN_CEILING` | no | service env file | `config.ts` | `0` (no limit) |
| `ULTRATHINK_DAILY_TOKEN_CEILING` | no | service env file | `config.ts` | `0` (no limit) |
| `ULTRATHINK_BREAKER_FAILURES` | no | service env file | `config.ts` | `5` |
| `ULTRATHINK_BREAKER_WINDOW_MS` | no | service env file | `config.ts` | `60000` |
| `ULTRATHINK_BREAKER_OPEN_MS` | no | service env file | `config.ts` | `30000` |
| `ULTRATHINK_MAX_INFLIGHT` | no | service env file | `config.ts` | `256` |
| `ULTRATHINK_PRIORITY_RESERVE_PCT` | no | service env file | `config.ts` | `25` |
| `ULTRATHINK_FAIR_QUEUE_DEPTH` | no | service env file | `config.ts` | `16` |
| `ULTRATHINK_FAIR_QUEUE_WAIT_MS` | no | service env file | `config.ts` | `1500` |
| `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT` | no | service env file | `config.ts` | `50` |
| `ULTRATHINK_LAG_TARGET_MS` | no | service env file | `config.ts` | `100` |
| `ULTRATHINK_REPLICA_CAPACITY_RPS` | no | service env file | `config.ts` | `20` |
| `ULTRATHINK_ABUSE_FAILURES_PER_MINUTE` | no | service env file | `config.ts` | `20` |
| `ULTRATHINK_PENALTY_BASE_SEC` | no | service env file | `config.ts` | `60` |
| `ULTRATHINK_PENALTY_MAX_SEC` | no | service env file | `config.ts` | `3600` |
| `ULTRATHINK_DRAIN_MS` | no | service env file | `config.ts` | `5000` |
| `ULTRATHINK_RETENTION_DAYS` | no | service env file | `config.ts` | `30` (`0` turns the sweep off) |
| `ULTRATHINK_AUDIT_LOG` | no | service env file | `config.ts` | `1` |
| `ULTRATHINK_AUDIT_ANCHOR_EVERY` | no | service env file | `config.ts` | `1000` |
| `ULTRATHINK_AUDIT_SEGMENT_BYTES` | no | service env file | `config.ts` | `67108864` |
| `ULTRATHINK_AUDIT_RETENTION_DAYS` | no | service env file | `config.ts` | `365` |
| `ULTRATHINK_AUDIT_WATCH_MS` | no | service env file | `config.ts` | `1000` |
| `ULTRATHINK_AUDIT_SINK_QUEUE` | no | service env file | `config.ts` | `10000` |
| `ULTRATHINK_AUDIT_RULES` | no | service env file | `config.ts` | unset (built-in rules) |
| `ULTRATHINK_AUDIT_HTTP_URL` | no | service env file | `config.ts` | unset |
| `ULTRATHINK_AUDIT_HTTP_TOKEN` | yes | service env file | `config.ts` | unset |
| `ULTRATHINK_AUDIT_SYSLOG` | no | service env file | `config.ts` | unset |
| `ULTRATHINK_AUDIT_KAFKA_REST_URL` | no | service env file | `config.ts` | unset; set together with the topic |
| `ULTRATHINK_AUDIT_KAFKA_TOPIC` | no | service env file | `config.ts` | unset; set together with the REST URL |
| `ULTRATHINK_OTLP_ENDPOINT` | no | service env file | `config.ts` | unset |
| `ULTRATHINK_CHAOS` | no | service env file | `config.ts` | `0`; staging only |
| `ULTRATHINK_CHAOS_ENV` | no | service env file | `config.ts` | unset; must be `staging` when chaos is on |
| `ULTRATHINK_CHAOS_PLAN` | no | service env file | `config.ts` | unset; required when chaos is on |

Flags take exactly `1` or `0`; any other value stops the service at start. Two more rules matter when you bring variables from an older setup: `ULTRATHINK_PLANNING_BACKEND` is refused, and a variable whose name contains `openrouter` (or `ULTRATHINK_MODEL_REASONING_EFFORT`) is ignored and reported once in the log by name only. The hosted service has no OpenRouter path.

When server-side planning is on, the service starts `claude -p` children and gives them only the variables below, read from the service's own environment (`services/ultrathink/engine/plan.ts`). Nothing else from your env file reaches the child.

| Variable | Secret | Scope | Where read | Default |
|---|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | service env file | `services/ultrathink/engine/plan.ts` | unset; the service user's own `claude` login is used instead |
| `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `HOME`, `GROK_HOME` | no | service environment | `services/ultrathink/engine/plan.ts` | unset |
| `PATH`, `TZ`, `LANG`, `LC_ALL`, `TMPDIR` | no | service environment | `services/ultrathink/engine/plan.ts` | unset |

## Plugin on a host

Source: the files named in the table. These are read by the hooks, commands and CLIs (`bin/ultrathink`, `bin/ultrathink-mcp`, `bin/ultrathink-ship`) in the agent's environment. They are a selection of the ones you are most likely to set; every variable the plugin reads is in the [environment reference](../environment.md) and in [Configuration](../configuration.md#environment-variables). Credentials have a second home, the credential store written by `bin/ultrathink-mcp auth set-key`, and where both exist the stored key wins.

| Variable | Secret | Scope | Where read | Default |
|---|---|---|---|---|
| `ULTRATHINK_UPLIFT` | no | agent process | `src/host/plan.ts`, `hooks/uplift.ts` | unset (planning on); `0` plans nothing |
| `ULTRATHINK_TRACK` | no | agent process | `src/uplift/commands.ts` | unset; `0` creates no tracker rows |
| `ULTRATHINK_SHIP` | no | agent process | `src/ship/policy.ts` | unset; `0` removes the ship step |
| `ULTRATHINK_DECISIONS` | no | agent process | `src/decisions/flow.ts` | unset; `0` turns Jev decisions off |
| `ULTRATHINK_HINDSIGHT` | no | agent process | `src/hindsight/settings.ts` | unset; `0` turns Hindsight off |
| `ULTRATHINK_RAGFLOW` | no | agent process | `src/ragflow/types.ts` | unset; `0` turns RAGFlow off |
| `ULTRATHINK_TEACH` | no | agent process | `src/teach/types.ts` | unset; `0` turns Teachable Moments off |
| `ULTRATHINK_GATEWAY` | no | agent process | `src/gateway/settings.ts` | unset; `0` forces the direct clients |
| `ULTRATHINK_HOST` | no | agent process | `src/host/detect.ts` | detected |
| `ULTRATHINK_STATE_DIR` | no | agent process | `src/host/paths.ts` | the host's state directory |
| `ULTRATHINK_MCP_STORE` | no (path to a secret store) | agent process | `src/mcp/store.ts` | `~/.config/ultrathink/mcp-credentials.json` |
| `HINDSIGHT_API_URL` | no | agent process | `src/hindsight/settings.ts` | unset; used only when the config key is empty |
| `HINDSIGHT_API_KEY`, `HINDSIGHT_API_TOKEN` | yes | agent process | `src/hindsight/settings.ts` | unset; a stored key wins |
| `RAGFLOW_URL` | no | agent process | `src/ragflow/settings.ts` | unset; used only when the config key is empty |
| `RAGFLOW_API_KEY` | yes | agent process | `src/ragflow/settings.ts` | unset; a stored key wins |
| `SUBSTRATE_URL` | no | agent process | `src/stack/substrate.ts` | unset; wins over the config key |
| `SUBSTRATE_TOKEN` | yes | agent process | `src/stack/substrate.ts` | unset |
| `SUBSTRATE_TIMEOUT_MS` | no | agent process | `src/stack/substrate.ts` | `1500` |
| `SUBSTRATE_DISABLED` | no | agent process | `src/stack/substrate.ts` | unset; `1` disables Substrate |
| `ULTRATHINK_OPENROUTER_KEY` | yes | agent process | `src/decisions/gate.ts` | unset; a stored key wins |
| `DESK_GATEWAY_URL` | no | agent process | `src/gateway/settings.ts` | unset; wins over the config key |
| `DESK_GATEWAY_TOKEN` | yes | agent process | `src/gateway/settings.ts` | unset; the stored credential wins |
| `BUN` | no | agent process | `bin/run-bun` | search order in [Finding Bun](../configuration.md#finding-bun) |

## Kill-switch polarity

Two conventions coexist, and mixing them up leaves a feature on while you believe it is off:

- **Plugin kill switches disable with the exact value `0`.** `ULTRATHINK_UPLIFT=0`, `ULTRATHINK_TRACK=0`, `ULTRATHINK_SHIP=0`, `ULTRATHINK_DECISIONS=0`, `ULTRATHINK_HINDSIGHT=0`, `ULTRATHINK_RAGFLOW=0`, `ULTRATHINK_TEACH=0` and `ULTRATHINK_GATEWAY=0`. Unset leaves the feature to its config. Any other value, `false` and `off` included, disables nothing.
- **`SUBSTRATE_DISABLED=1` is the opposite: `1` disables.** `SUBSTRATE_DISABLED=0` or unset leaves Substrate to its URL and config.
- **Service flags are strict, not lenient.** `ULTRATHINK_SERVER_PLANNING`, `ULTRATHINK_PLAINTEXT_LOOPBACK`, `ULTRATHINK_AUDIT_LOG` and `ULTRATHINK_CHAOS` take `1` (on) or `0` (off); `ULTRATHINK_SERVER_PLANNING` and `ULTRATHINK_PLAINTEXT_LOOPBACK` are off when unset, `ULTRATHINK_AUDIT_LOG` is on when unset. Any other value stops the service at start with the variable named.

## Precedence

Which source wins for a setting (environment, config file layer, stored credential) differs by setting family, and the [environment reference](../environment.md) states the order for each family as the code implements it. Where the order is already stated elsewhere in this repository: stored credentials beat their environment fallbacks (the Hindsight, RAGFlow and OpenRouter keys in [Configuration](../configuration.md#environment-variables)), `SUBSTRATE_URL` beats `substrate.url`, and a kill switch beats its config key.

## Passing variables to a client's MCP entry

Put each value in the entry's `env` block (or `-e` for `claude mcp add`), as in the [copy-paste configs](use-ultrathink-in-chat.md#copy-paste-configs-by-client). Whether an unset `${VAR}` reference inside an MCP entry expands to an empty string, stays literal or stops the server differs by client and is **UNVERIFIED** here; do not rely on it. Never put a secret in a file that is committed: the plugin's own `plugins/ultrathink-connector/.mcp.json` carries only a URL for that reason.
