# Environment variables

This file is generated from the environment registry (`src/env-registry.ts`) by `bun scripts/render-env-docs.ts`. Do not edit it by hand: a test fails when it differs from what the registry renders. Every variable below is optional unless its description says it is required. `.env.example` has one placeholder line per variable. [Configuration](configuration.md) explains the config files these variables sit next to.

A variable that is empty or only whitespace counts as unset. A bad value is never fatal for the plugin: the reader falls back to its default, and `ultrathink doctor` names the variable (never its value). The hosted service is stricter: it refuses to start on a bad value.

## Which source wins

The order differs by setting family. Each line below is how the code resolves it today.

- **Substrate URL.** `SUBSTRATE_URL` wins over `substrate.url` in the config file. `SUBSTRATE_DISABLED=1` beats both and no request is made.
- **Substrate bearer.** `SUBSTRATE_TOKEN`, then the first line of the file named by `SUBSTRATE_TOKEN_FILE`, then the first line of `SUBSTRATE_TOKENS_DIR/<surface>`. There is no stored copy.
- **Hindsight URL.** `hindsight.url` in the config file, then `HINDSIGHT_API_URL`, then `HINDSIGHT_URL`. This is the reverse of the Substrate URL: the config file wins here.
- **Swarm root.** A non-empty `ULTRATHINK_SWARM_ROOT` wins; `SWARM_ROOT` is read only when it is empty.
- **Secrets.** A key stored in the credential store (`bin/ultrathink-mcp auth set-key <provider> --stdin`) wins over its environment variable, for Hindsight (then `HINDSIGHT_API_KEY`, then `HINDSIGHT_API_TOKEN`), RAGFlow, the desk gateway and OpenRouter (`ULTRATHINK_OPENROUTER_KEY`).
- **Backend selectors.** `ULTRATHINK_HINDSIGHT_BACKEND`, `ULTRATHINK_RAGFLOW_BACKEND` and `ULTRATHINK_SUBSTRATE_BACKEND` (`direct` or `gateway`) win over the `backend` key of their config section. Any other value is ignored. `ULTRATHINK_GATEWAY=0` forces every one of them to `direct`.
- **Kill switches.** An environment kill switch wins over the config file, and no config key turns the feature back on. Only the one value shown in the table switches it off: `0` for the `ULTRATHINK_*` switches, `off` for `ULTRATHINK_REALM`, and `1` for `SUBSTRATE_DISABLED`. Any other value leaves the feature on and `ultrathink doctor` reports it. `ULTRATHINK_RAGFLOW` ignores whitespace around the `0`, and `ULTRATHINK_REALM` ignores case and whitespace.
- **Project config.** The project file `<cwd>/.claude/ultrathink.json` is read last but is limited. It cannot choose executables, the desk gateway, the state settings, the Cursor pstack bridge or swarm auto-run, and for Hindsight, RAGFlow and Teachable Moments it can only turn a feature off or lower it. The user files are not limited.

## Checking your settings

- `ultrathink doctor` runs nine sections. The `env` section checks every non-secret variable below against its kind and range and lists all problems in one report, never a value. The `stack` section runs the free, read-only probes of the five stack links, the same ones `ultrathink stack` runs without `--live`: no tokens are spent, the Hindsight and Realm probes send no key, and the Decisions link makes no request.
- `ultrathink stack` prints one line per stack link with its status, the reason and a fix line. --live also runs the Decisions check (spends one request; moves the rail breaker and writes a usage row exactly like `decisions check`).
- `bun services/ultrathink/server.ts --check-config` validates the hosted service's variables without starting it. It prints `config ok` and exits 0, or prints `ultrathink: N configuration problems` followed by one line per problem and exits 1. No line contains a secret value.

## Plugin variables

Read by the hooks, `bin/ultrathink` and the other plugin commands, on every host. Includes the state and host paths.

| name | aliases | secret | kind | default | description |
| --- | --- | --- | --- | --- | --- |
| `ULTRATHINK_UPLIFT` | — | no | bool01 (disabled by 0) | — | Set to 0 to plan no prompt in this process. The uplift prefix does not override it. |
| `ULTRATHINK_TRACK` | — | no | bool01 (disabled by 0) | — | Set to 0 so the planner creates no tracker rows in this process. |
| `ULTRATHINK_SHIP` | — | no | bool01 (disabled by 0) | — | Set to 0 for no ship instruction in the plan and no ship nudge, even with ship.enabled. |
| `ULTRATHINK_RAGFLOW` | — | no | bool01 (disabled by 0) | — | Set to 0 to send no RAGFlow request in this process; whitespace around the 0 is trimmed. |
| `ULTRATHINK_TEACH` | — | no | bool01 (disabled by 0) | — | Set to 0 to turn Teachable Moments off for this process (no capture, recall or promote). |
| `ULTRATHINK_GATEWAY` | — | no | bool01 (disabled by 0) | — | Set to 0 to force Hindsight, RAGFlow and the Substrate brief back to their direct backends. |
| `ULTRATHINK_PSTACK` | — | no | bool01 (disabled by 0) | — | Set to 0 so the Cursor pstack hook injects nothing for this process. |
| `ULTRATHINK_HINDSIGHT_BACKEND` | — | no | enum (one of direct, gateway) | — | Chooses the Hindsight backend and wins over hindsight.backend unless ULTRATHINK_GATEWAY is 0. |
| `ULTRATHINK_RAGFLOW_BACKEND` | — | no | enum (one of direct, gateway) | — | Chooses the RAGFlow backend and wins over ragflow.backend unless ULTRATHINK_GATEWAY is 0. |
| `ULTRATHINK_SUBSTRATE_BACKEND` | — | no | enum (one of direct, gateway) | — | Chooses the Substrate brief backend and wins over substrate.backend unless ULTRATHINK_GATEWAY is 0. |
| `RAGFLOW_URL` | — | no | url | — | RAGFlow base URL, used only when ragflow.url is empty. |
| `RAGFLOW_API_KEY` | — | yes | string | — | RAGFlow API key, used when no ragflow key is stored. The stored key wins. |
| `DESK_GATEWAY_URL` | — | no | url | — | Desk gateway base URL. It wins over gateway.url in the config file. |
| `DESK_GATEWAY_SEAT` | — | no | string | — | Desk gateway seat name; a name that does not match [a-z][a-z0-9-]{0,31} is ignored. |
| `DESK_GATEWAY_TOKEN` | — | yes | string | — | Desk gateway token, used when no gateway token is stored. The stored token wins. |
| `DESK_GATEWAY_TIMEOUT_MS` | — | no | int (1 to 120000) | — | Timeout of one desk gateway request in milliseconds; a value outside the range is ignored. |
| `ULTRATHINK_MCP_STORE` | — | no | path | `$XDG_CONFIG_HOME/ultrathink/mcp-credentials.json` | Path of the credential store. |
| `ULTRATHINK_OAUTH_REDIRECT` | — | no | url | — | OAuth callback URL for ultrathink-mcp auth login; the --redirect flag wins over it. |
| `ULTRATHINK_OAUTH_TAILSCALE` | — | no | bool1 | — | Set to 1 to receive the OAuth callback through tailscale serve on a remote session. |
| `ULTRATHINK_DEBUG` | — | no | bool1 | — | Set to 1 to write ultrathink log lines and one line per Jev decision to stderr. |
| `ULTRATHINK_MCP_DEBUG` | — | no | bool1 | — | Set to 1 so ultrathink-mcp serve writes relay log lines to stderr. |
| `ULTRATHINK_PROGRESS_FD` | — | no | int (at least 3) | — | File descriptor that receives one JSON progress line per event; 3 or higher, else ignored. |
| `ULTRATHINK_HOST` | — | no | enum (one of claude-code, grok-build, hermes, muse, omp, prime-agent, cursor) | — | Forces the detected host; an unknown value is ignored. |
| `ULTRATHINK_STATE_DIR` | — | no | path | — | Directory for control state and session records instead of the host default. The hosted service reads it too and defaults to /var/lib/ultrathink; a path inside .planning is ignored. |
| `ULTRATHINK_CONFIG_DIR` | — | no | path | — | Directory holding config.json for the Cursor pstack hook and the doctor pstack section only. |
| `ULTRATHINK_PSTACK_CURSOR_DIR` | — | no | path | — | Absolute Cursor directory for the pstack hook; it wins over pstack.cursorDir. |
| `ULTRATHINK_AGENT_SKILLS_DIR` | — | no | path | `~/.agents/skills` | Shared Agent Skills directory that scripts/setup.ts installs into. |
| `XDG_CONFIG_HOME` | — | no | path | `~/.config` | Base of the user config, the credential store and some host state directories. |
| `CLAUDE_CONFIG_DIR` | — | no | path | `~/.claude` | Claude user config directory, also the Claude Code state directory. |
| `GROK_HOME` | — | no | path | `~/.grok` | Grok home directory, also the Grok Build state directory when GROK_PLUGIN_DATA is unset. |
| `GROK_PLUGIN_DATA` | — | no | path | — | Grok Build state directory. |
| `HERMES_HOME` | — | no | path | `~/.hermes` | Hermes home directory, also the Hermes state directory. |
| `PI_CODING_AGENT_DIR` | — | no | path | `~/.omp/agent` | Omp agent directory, also the Omp state directory. |
| `PRIME_AGENT_CODING_AGENT_DIR` | — | no | path | `~/.prime/agent` | Prime Agent directory, also the Prime Agent state directory. |
| `ULTRATHINK_LOG_LEVEL` | — | no | string | `warn` | Log level of the stdio tool host: info, warn or error, compared without case; anything else means warn. |

## Hosted service variables

Read only by the hosted service (`services/ultrathink`) at start. A bad value stops it, and `--check-config` lists every problem.

| name | aliases | secret | kind | default | description |
| --- | --- | --- | --- | --- | --- |
| `ULTRATHINK_PUBLIC_ORIGIN` | — | no | url | — | Public origin of the hosted service: https, or http for localhost and 127.0.0.1; scheme, host and port only. Required. |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | — | yes | string | — | Argon2 or bcrypt hash of the owner password, as Bun.password.hash makes it. Required. |
| `ULTRATHINK_SESSION_SECRET` | — | yes | string | — | Session signing secret of at least 32 characters. Required. |
| `ULTRATHINK_SESSION_SECRET_PREVIOUS` | — | yes | string | — | Comma list of up to 4 earlier session secrets still accepted, so a rotation signs nobody out. |
| `ULTRATHINK_CONNECTOR_KEY` | — | yes | string | — | Connector key of at least 32 characters, for the MCP connector route. |
| `ULTRATHINK_PORT` | — | no | int (1024 to 65535) | `8795` | Listen port of the hosted service. |
| `ULTRATHINK_ALLOWED_ORIGINS` | — | no | string | — | Comma list of bare origins (https or http) allowed to call the service from a browser. |
| `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` | — | no | string | — | Comma list of bare https origins accepted as OAuth redirect targets. |
| `ULTRATHINK_PLANNING_MODEL` | — | no | string | `claude-haiku-5-5` | Claude model id of the hosted planner: 1 to 80 characters from letters, digits, dot, underscore, colon and dash. |
| `ULTRATHINK_PLANNING_FALLBACK` | — | no | enum (one of none, grok) | `none` | Whether a failed Claude call fails over to Grok. |
| `ULTRATHINK_SERVER_PLANNING` | — | no | bool01 | `0` | Set to 1 to let the service plan on the server. |
| `ULTRATHINK_PLAINTEXT_LOOPBACK` | — | no | bool01 | `0` | Set to 1 to run without TLS; for development and local smoke tests only. |
| `ULTRATHINK_MAX_INPUT_CHARS` | — | no | int (at least 0) | `4000000` | Longest accepted prompt in characters; 0 means no limit, otherwise at least 1. |
| `ULTRATHINK_MAX_ANSWER_CHARS` | — | no | int (1 to 200000) | `20000` | Longest accepted answer in characters. |
| `ULTRATHINK_RUN_TOKEN_CEILING` | — | no | int (at least 0) | `0` | Token ceiling of one run; 0 means unlimited, otherwise at least 1. |
| `ULTRATHINK_DAILY_TOKEN_CEILING` | — | no | int (at least 0) | `0` | Token ceiling per day; 0 means unlimited, otherwise at least 1. |
| `ULTRATHINK_PLAN_CONCURRENCY` | — | no | int (1 to 6) | `2` | Most claude children in flight at once. |
| `ULTRATHINK_MAX_CONCURRENT_PLANS` | — | no | int (1 to 8) | `2` | Most plans running at once. |
| `ULTRATHINK_MODEL_TIMEOUT_MS` | — | no | int (0 to 600000) | `0` | Timeout of one model call in milliseconds; 0 means unlimited, otherwise 5000 or more. |
| `ULTRATHINK_PLAN_TIMEOUT_MS` | — | no | int (0 to 1800000) | `0` | Timeout of one plan in milliseconds; 0 means unlimited, otherwise 30000 or more. |
| `ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS` | — | no | int (0 to 32000) | `0` | Output token cap of one model call; 0 means no configured cap, otherwise 256 or more. |
| `ULTRATHINK_BREAKER_FAILURES` | — | no | int (0 to 100) | `5` | Upstream failures within the window that open the breaker; 0 disables it. |
| `ULTRATHINK_BREAKER_WINDOW_MS` | — | no | int (1000 to 3600000) | `60000` | Window in which upstream failures are counted, in milliseconds. |
| `ULTRATHINK_BREAKER_OPEN_MS` | — | no | int (1000 to 600000) | `30000` | How long the breaker stays open before a trial request, in milliseconds. |
| `ULTRATHINK_MAX_INFLIGHT` | — | no | int (1 to 10000) | `256` | Most concurrent HTTP requests the router admits. |
| `ULTRATHINK_PRIORITY_RESERVE_PCT` | — | no | int (0 to 90) | `25` | Percent of in-flight capacity kept free for the owner. |
| `ULTRATHINK_FAIR_QUEUE_DEPTH` | — | no | int (0 to 1000) | `16` | Over-budget requests that may wait per priority class; 0 refuses at once. |
| `ULTRATHINK_FAIR_QUEUE_WAIT_MS` | — | no | int (1 to 60000) | `1500` | Longest wait in the fair-share queue, in milliseconds. |
| `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT` | — | no | int (10 to 100) | `50` | Lowest percentage the adaptive quota may shrink the request windows to. |
| `ULTRATHINK_LAG_TARGET_MS` | — | no | int (10 to 5000) | `100` | Event-loop lag above which the adaptive quota shrinks, in milliseconds. |
| `ULTRATHINK_REPLICA_CAPACITY_RPS` | — | no | int (1 to 100000) | `20` | Requests per second one replica is assumed to serve. |
| `ULTRATHINK_ABUSE_FAILURES_PER_MINUTE` | — | no | int (1 to 10000) | `20` | Failures per minute from one IP that start an abuse penalty. |
| `ULTRATHINK_PENALTY_BASE_SEC` | — | no | int (1 to 86400) | `60` | Length of an IP's first abuse penalty block, in seconds. |
| `ULTRATHINK_PENALTY_MAX_SEC` | — | no | int (1 to 86400) | `3600` | Longest abuse penalty block in seconds; never below the base block. |
| `ULTRATHINK_DRAIN_MS` | — | no | int (0 to 60000) | `5000` | Wait after shutdown begins so in-flight work can finish, in milliseconds. |
| `ULTRATHINK_RETENTION_DAYS` | — | no | int (0 to 3650) | `30` | Days of finished jobs, sessions and journals to keep; 0 disables the sweep. |
| `ULTRATHINK_AUDIT_LOG` | — | no | bool01 | `1` | Set to 0 to stop writing the append-only audit log. |
| `ULTRATHINK_AUDIT_ANCHOR_EVERY` | — | no | int (1 to 1000000) | `1000` | Audit records between anchor records of the hash chain. |
| `ULTRATHINK_AUDIT_SEGMENT_BYTES` | — | no | int (1048576 to 4294967296) | `67108864` | Size at which the audit log rolls to a new segment, in bytes. |
| `ULTRATHINK_AUDIT_RETENTION_DAYS` | — | no | int (0 to 36500) | `365` | Days of audit segments to keep; 0 keeps them all. |
| `ULTRATHINK_AUDIT_WATCH_MS` | — | no | int (100 to 1000) | `1000` | Interval of the audit integrity watch, in milliseconds. |
| `ULTRATHINK_AUDIT_SINK_QUEUE` | — | no | int (1 to 1000000) | `10000` | Envelopes each audit sink may hold waiting before the oldest is dropped. |
| `ULTRATHINK_AUDIT_RULES` | — | no | string | — | JSON array of anomaly rules; unset means the built-in rules. |
| `ULTRATHINK_AUDIT_HTTP_URL` | — | no | url | — | HTTP audit sink endpoint: https, or http to 127.0.0.1 or localhost. |
| `ULTRATHINK_AUDIT_HTTP_TOKEN` | — | yes | string | — | Token for the HTTP audit sink: at least 16 printable ASCII characters. |
| `ULTRATHINK_AUDIT_SYSLOG` | — | no | string | — | Syslog audit sink as host:port, with a port from 1 to 65535. |
| `ULTRATHINK_AUDIT_KAFKA_REST_URL` | — | no | url | — | Kafka REST proxy endpoint of the audit sink; set together with the topic. |
| `ULTRATHINK_AUDIT_KAFKA_TOPIC` | — | no | string | — | Kafka topic of the audit sink; set together with the REST URL. |
| `ULTRATHINK_OTLP_ENDPOINT` | — | no | url | — | OTLP/JSON trace collector base URL: https, or http to loopback. Unset disables span export. |
| `ULTRATHINK_TLS_CERT` | — | no | path | — | Absolute path of the server certificate; set with the key and the client CA, or none. |
| `ULTRATHINK_TLS_KEY` | — | no | path | — | Absolute path of the server certificate key; set with the certificate and the client CA, or none. |
| `ULTRATHINK_TLS_CLIENT_CA` | — | no | path | — | Absolute path of the CA that signs client certificates; set with the certificate and the key, or none. |
| `ULTRATHINK_SPIFFE_TRUST_DOMAIN` | — | no | string | `ultrathink.internal` | SPIFFE trust domain that peer certificate identities must belong to. |
| `ULTRATHINK_CHAOS` | — | no | bool01 | `0` | Set to 1 to arm fault injection at the upstream seam; needs the staging environment and a plan. |
| `ULTRATHINK_CHAOS_ENV` | — | no | string | — | Must be staging whenever chaos is enabled. |
| `ULTRATHINK_CHAOS_PLAN` | — | no | path | — | Absolute path of the fault plan; required whenever chaos is enabled. |

## Stack variables

Settings for the five stack links: Substrate, Swarm, Realm, Decisions and Hindsight. `ultrathink stack` reports their state.

| name | aliases | secret | kind | default | description |
| --- | --- | --- | --- | --- | --- |
| `ULTRATHINK_DECISIONS` | — | no | bool01 (disabled by 0) | — | Set to 0 to turn every Jev decision point off for this process, whatever the config says. |
| `ULTRATHINK_HINDSIGHT` | — | no | bool01 (disabled by 0) | — | Set to 0 to send no Hindsight request in this process, even with hindsight.enabled. |
| `SUBSTRATE_DISABLED` | — | no | bool1 (disabled by 1) | — | Set to 1 to never contact Agent Substrate, even when SUBSTRATE_URL or substrate.url is set. |
| `ULTRATHINK_REALM` | — | no | enum (disabled by off) | — | Set to off to skip the Realm probe; any other value leaves it on. |
| `SUBSTRATE_URL` | — | no | url | — | Agent Substrate base URL. It wins over substrate.url in the config file. |
| `SUBSTRATE_TOKEN` | — | yes | string | — | Bearer sent to Agent Substrate. It wins over SUBSTRATE_TOKEN_FILE and the per-surface tokens directory. |
| `SUBSTRATE_TOKEN_FILE` | — | no | path | — | File whose first line is the bearer when SUBSTRATE_TOKEN is empty. It wins over the per-surface tokens directory. |
| `SUBSTRATE_TOKENS_DIR` | — | no | path | `/etc/substrate/tokens` | Directory of per-surface bearer files, read as DIR/SURFACE when neither SUBSTRATE_TOKEN nor SUBSTRATE_TOKEN_FILE gives one. The surface is the host name (claude-code, cursor, hermes, omp, muse, grok-build; prime-agent uses pi) and must match [a-z0-9][a-z0-9-]{0,63}. |
| `SUBSTRATE_TIMEOUT_MS` | — | no | int (at least 1) | `1500` | Timeout of one Agent Substrate request in milliseconds. A positive number; anything else means the default. |
| `HINDSIGHT_API_URL` | `HINDSIGHT_URL` | no | url | — | Hindsight base URL, used only when hindsight.url is empty. HINDSIGHT_URL is read when this one is empty. |
| `HINDSIGHT_API_KEY` | — | yes | string | — | Hindsight API key, used when no hindsight key is stored. The stored key wins. |
| `HINDSIGHT_API_TOKEN` | — | yes | string | — | Hindsight API key, used only when no key is stored and HINDSIGHT_API_KEY is empty. |
| `ULTRATHINK_OPENROUTER_KEY` | — | yes | string | — | OpenRouter key for Jev decisions, used when no openrouter key is stored. The stored key wins. |
| `ULTRATHINK_DECISIONS_URL` | — | no | url | `https://openrouter.ai/api/alpha/decisions` | Decisions endpoint. Only an https://openrouter.ai URL or a loopback URL is accepted; anything else is ignored. |
| `ULTRATHINK_SWARM_ROOT` | `SWARM_ROOT` | no | path | — | Absolute path of an agent-swarm checkout, required for swarm lanes. SWARM_ROOT is read when this one is empty. |
| `ULTRATHINK_SWARM_MAX_LANES` | — | no | int (1 to 6) | `3` | Most swarm lanes alive at once across all commands, and the most briefs one command starts. A value that is not a number from 1 up means 3; larger values are cut to 6. |
| `SWARM_AUTONOMOUS_RUN_CAP_S` | — | no | string | — | Run cap in seconds, passed through unchanged to each swarm lane. |
| `SWARM_AUTONOMOUS_RUN_GRACE_S` | — | no | string | `15` | Seconds between SIGTERM and SIGKILL when a lane is stopped; a number of 0 or more, else 15. |
