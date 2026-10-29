# Use /ultrathink in Claude, Claude Code and Grok Chat

This guide connects a chat client to the hosted ultrathink server, or to the same connector running on your machine over stdio, and shows how to run `/ultrathink <request>` and the other connector commands from it. The hosted server is at `https://ultrathink.swcstudio.space/mcp`. For the server's operation, see the [runbook](../ops/runbook-ultrathink.md). For Grok Bot, see [Connect Grok Bot to ultrathink](../ops/grok-bot-setup-ultrathink.md). For every command and what each client does with it, see [Commands: Connector](../commands.md#connector).

**Status: not verified live.** This connector has never been connected to Claude chat, Claude Code or Grok Chat in a live session. What a client does with it is taken from vendor documentation and public issue reports read on 2026-10-19, with the source named where it matters; anything no source settles is marked *not verified*. The list of what has and has not been run is under [What is not verified](#what-is-not-verified).

## What /ultrathink does in a chat

`/ultrathink` runs the planning part of the ultrathink plugin and hands the result back to the chat model. The pipeline has four steps:

1. **Uplift.** The request is rewritten as a structured specification.
2. **Graph of Thought.** The specification is split into 5 to 8 nodes, each a question to settle, in dependency order.
3. **Chain of Thought.** Each node gets numbered reasoning steps and a conclusion. Nodes run level by level, three at a time.
4. **Clarifying questions.** The pipeline lists what it could not settle, each with a default answer.

The chat model then reads the plan, asks you the questions that matter (or states the defaults it assumes), and carries out the plan.

This path has no Notion, no Linear, no tracking, no shipping, and no Hindsight or RAGFlow lookups. The Jev decision gate is off: server-side decisions stay disabled until their spend is metered. Nothing is written to your repository or to any tracker.

## Two modes

The server offers two ways to do the thinking. The tool list tells you which one is active.

| | Server-side mode | Client-driven mode |
|---|---|---|
| Who thinks | The server calls a planning model: `claude -p` on the owner's own Claude plan login (one owner only), with an optional Grok Build fallback. | The chat model answers each planning prompt itself. |
| Tools the chat model uses | `ultrathink_uplift`, then `ultrathink_result`; `ultrathink_cancel` to stop a plan the user abandons | `ultrathink_plan`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_answer`, `ultrathink_status`, then `ultrathink_result` |
| Tool count | 11 tools: the six client-driven tools, `ultrathink_uplift`, the three connector tools `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command`, and `ultrathink_cancel` | 9 tools (`ultrathink_uplift` and `ultrathink_cancel` are not listed) |
| Who pays | The owner's own Claude plan (its usage limits; one owner only). | Your chat plan. The server makes no paid call. |
| Used by | The hosted server when planning is configured: Grok Chat, Claude chat, Claude Code | Grok Bot, the local stdio server, or any client when server-side mode is off |

Server-side mode is on only when the operator sets `ULTRATHINK_SERVER_PLANNING=1`, an explicit opt-in; the planner runs on the service user's Claude plan login, and OpenRouter is not involved (it was retired from the hosted service). Unset or `0` means client-driven mode: the server lists no `ultrathink_uplift` and no `ultrathink_cancel`, and its prompt and instructions describe the client-driven loop. The client-driven tools stay available in both modes. `ultrathink_result` returns the plan for a finished session from either mode. In server-side mode, a start can be refused as `busy` (all plan slots and the wait queue are taken; the error says `retry after 30s`) or `upstream_unavailable` (the failure-rate breaker is open), and `ultrathink_cancel` with the `sessionId` stops a plan that is still running and frees its place. A session is visible only to the caller that started it (the owner sees all); see [Hosted service under load](../architecture.md#hosted-service-under-load).

## Connect a client

All hosted routes use the same URL and the same login: OAuth 2.1 with PKCE, and the owner password on the consent page. The server finds each client through its metadata at `/.well-known/oauth-protected-resource/mcp` and registers it with dynamic client registration.

The server accepts a client's redirect URI only when it is https on one of these origins, or http on loopback (any port):

- `https://claude.ai`
- `https://claude.com`
- `https://grok.com`
- `https://console.x.ai`

The operator can add origins with `ULTRATHINK_OAUTH_REDIRECT_ORIGINS`. A client with any other redirect origin fails at registration.

The consent page names the client, says that the name is unverified, and shows the origin you will be sent back to. Approve only an address you recognize.

### What each client can do

| | Claude Desktop and claude.ai chat | Claude Code | Grok Chat | Local stdio |
|---|---|---|---|---|
| How it connects | Plugin bundle (Connectors tab) or custom connector, from Anthropic's cloud | `claude mcp add` | Custom connector at grok.com/connectors | The client starts `bin/ultrathink-connector` |
| Sign-in | OAuth only | OAuth, or the `x-connector-key` header | OAuth only | None (local process) |
| Typed `/ultrathink ...` | Plain text unless picked from the "/" menu, where the plugin's commands appear | Plugin commands and `/mcp__ultrathink__<prompt>` | No known command surface; tool descriptions and custom instructions | Depends on the client |
| MCP prompts | Only as "+" menu attachments, not as slash commands | `/mcp__ultrathink__<prompt>` | No evidence of any prompt surface | Depends on the client |
| Server `instructions` | Not delivered to the model | Delivered, cut at 4,096 characters | Not verified | Depends on the client |
| Tool list refresh | Not verified; remove and re-add the connector after a tool change | Honours `list_changed` and reconnects with `/mcp` (this server sends no `list_changed`, so reconnect after a tool change) | Fetched once and cached; only re-authentication refreshes it | The client restarts the process |

What the evidence says, and where it stops:

- **OAuth only.** Claude's custom connector dialog offers OAuth client settings; its "Request headers" option is a beta for limited organizations, takes at most four headers, and allows only standard names (`authorization`, `x-api-key`, `x-auth-token`) or names Anthropic approves, so the connector key header is not usable there. Grok's custom connector UI was only seen to offer OAuth, and no static header field was found in xAI's documentation or in operator reports. The `x-connector-key` header is for Grok Bot and Claude Code (`--header`). Sources: `https://claude.com/docs/connectors/custom/add-unlisted`, `https://docs.x.ai/grok/connectors`.
- **Grok never refreshes its tool list.** Grok fetches a connector's tools once, when it connects, and caches them. It does not refetch on `initialize` and ignores `list_changed`; only re-authenticating the connector refreshes the list, and the iOS app has no re-authenticate button. A maintainer confirmed this on 2026-10-13 in `https://github.com/xai-org/plugin-marketplace/issues/1402`. After any tool change on the server (for example the three connector tools added in this release, or a changed description), disconnect and reconnect the connector in Grok before testing.
- **Hosted Claude does not deliver server `instructions`.** Open issue `https://github.com/anthropics/claude-ai-mcp/issues/93`, still reproduced on 2026-10-15. The routing text therefore also sits in each tool's description, and the Claude plugin's skill carries the playbook. Claude Code does deliver instructions; the connector's stay under 3,500 characters because Claude Code cuts them at 4,096.
- **Prompts.** In Claude chat, a server's MCP prompts appear only as attachments in the "+" menu ("Add from ultrathink") and are not run as typed messages. Reliability is reported as poor: `https://github.com/anthropics/claude-ai-mcp/issues/333` describes prompts from custom connectors vanishing from the UI. In Claude Code they are slash commands named `/mcp__ultrathink__<prompt>`. Nothing found says Grok Chat has a prompt surface.
- **Claude Code gets `structuredContent` instead of `content`.** Anthropic documents that when a tool returns `structuredContent`, Claude Code hands the model that JSON instead of the `content` text (`https://claude.com/docs/connectors/building/mcp-apps/quickstart`). The connector therefore returns the same text twice, as the tool content and as `structuredContent.text`. What claude.ai chat and Grok Chat hand the model is not verified.
- **The plan leads with a wave tree.** The plan text starts with a plain-text wave tree in a code block, and the Mermaid diagram follows it. Whether Claude chat or Grok Chat renders a fenced `mermaid` block in a reply is not verified: no Anthropic or xAI document says it does. The tree is the part that is sure to be readable.
- **The MCP App card is unreliable in custom connectors.** The tools `ultrathink_uplift` and `ultrathink_graph` point at the `ui://ultrathink/graph` resource, an interactive card. Claude web and Desktop are listed as MCP Apps clients, but reports say custom (non-directory) connectors sometimes get text only or an empty frame (`https://github.com/anthropics/claude-ai-mcp/issues/471`, `/165`). The text result is complete without the card, so a client that does not draw it loses nothing but the picture. Grok Chat is not listed as an MCP Apps client.
- **Registration limit.** The server allows 10 client registrations per hour per client address, and Claude registers a new client on every fresh connection (dynamic client registration; Anthropic recommends client ID metadata documents instead, which this server does not implement). Anthropic's connector traffic comes from a fixed address range, so many fresh connections can exhaust the limit; the 11th registration returns 429 with `Retry-After`. Wait that long and connect again. The operator's checks are in runbook section 13.
- **Which protocol revision a hosted client opens with.** Claude is reported to open every connection with a `server/discover` request under `MCP-Protocol-Version: 2026-07-28`. This server speaks 2025-11-25, 2025-06-18 and 2025-03-26 and answers that probe with HTTP 400, which a spec-following client reads as "legacy server" before it falls back to `initialize`. That fallback is confirmed for the official TypeScript SDK 2.3.1 and Python SDK 2.3.0 against an earlier build of this server; for hosted Claude and for Grok Chat it is *not verified*. [Runbook section 13](../ops/runbook-ultrathink.md#13-connector-surface-and-diagnostics) shows how to read the first connection in the logs.

### Claude Desktop and claude.ai: plugin bundle

The plugin in `plugins/ultrathink-connector/` bundles six commands, a skill with the playbook, and the connector entry for the hosted server. It is the route that puts the commands in Claude chat's "/" menu: according to Anthropic, a plugin's commands and skills appear in that menu, labelled by plugin, and in chat a command loads as a skill that Claude applies (`https://claude.com/docs/plugins/platform-support`).

1. From the repository root, run `sh plugins/ultrathink-connector/package.sh`. It writes `plugins/ultrathink-connector/dist/ultrathink-connector-<version>.zip`.
2. In claude.ai or Claude Desktop, open **Customize > Plugins > Add > Upload plugin** and select the zip. Anthropic's documented limit for chat is 200 MB and 5,000 files.
3. Open the plugin, select its **Connectors** tab, then add and connect `ultrathink`. The consent page opens. Enter the owner password and click **Approve**.
4. In a chat, pick a command from the "/" menu, for example `/ultrathink` and then your request. Where Claude namespaces plugin commands they appear as `/ultrathink-connector:<name>`.

On Team and Enterprise plans an Owner may have to add the connector for the organization first. A typed `/ultrathink foo` that you did not pick from the menu is plain text to the model. To point the plugin at your own deployment, see `plugins/ultrathink-connector/README.md`.

### Claude Desktop and claude.ai: custom connector

Use this when you do not want the plugin. You get the tools, and the model follows a typed `/ultrathink` only because their descriptions tell it to.

1. Open Settings, then Connectors.
2. Choose **Add custom connector**.
3. Enter a name (`ultrathink`) and the URL `https://ultrathink.swcstudio.space/mcp`.
4. Leave the advanced OAuth client ID and secret empty. If the dialog asks how Claude should register, choose automatic registration; the "published identity" option needs client ID metadata documents, which this server does not advertise.
5. Choose **Connect**. The consent page opens. Enter the owner password and click **Approve**.
6. In a new chat, open the connectors menu and switch the ultrathink connector on for that chat. The auth settings cannot be edited after the connector is added; to change them, remove the connector and add it again.

Menu labels differ by app version and plan. Custom connectors may not be available on every plan. Claude shows an Allow once, Always allow or Blocked choice per tool; the read-only tools declare `readOnlyHint`, which Anthropic says lets them run without a per-call prompt.

### Claude Code

```bash
claude mcp add --transport http ultrathink https://ultrathink.swcstudio.space/mcp
```

Then run `/mcp` inside Claude Code, select `ultrathink`, and choose to authenticate. Claude Code opens the browser and receives the code on a loopback address, which the redirect rules allow. Enter the owner password on the consent page. Add `--scope user` to the command to make the server available in every project.

Claude Code can also send the connector key instead of running OAuth. The key is a secret: put it in a shell variable without echoing it, and know that Claude Code stores the header in its own configuration.

```bash
claude mcp add --transport http ultrathink https://ultrathink.swcstudio.space/mcp --header "x-connector-key: $ULTRATHINK_CONNECTOR_KEY"
```

The six prompts are `/mcp__ultrathink__ultrathink`, `/mcp__ultrathink__ultrathink-plan`, `/mcp__ultrathink__ultrathink-think`, `/mcp__ultrathink__ultrathink-last`, `/mcp__ultrathink__ultrathink-status` and `/mcp__ultrathink__ultrathink-quick`, with space-separated arguments, for example `/mcp__ultrathink__ultrathink plan a CSV export`. If you already have the ultrathink plugin installed in Claude Code, its own `/ultrathink-*` commands plan locally with no server; use the connector when you want the hosted planner. To load the connector's plugin bundle in Claude Code, run `claude --plugin-dir plugins/ultrathink-connector`.

### Grok Chat

1. Open grok.com/connectors and click **New Connector**.
2. Select **Custom**.
3. Enter the URL `https://ultrathink.swcstudio.space/mcp`.
4. Choose OAuth when Grok offers it. Grok opens the ultrathink consent page. If Grok shows a manual "OAuth Credentials Required" dialog, the server needs no client secret: it registers public clients (token auth method none, PKCE).
5. Enter the owner password and click **Approve**.
6. Check that the ultrathink tools are listed in the connector, including `ultrathink_uplift`, `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command`. If a tool you expect is missing, the list is stale: re-authenticate or reconnect (see above).

Grok Chat gets the tools only. There is no plugin bundle for it, so a typed `/ultrathink` works through the tool descriptions and, if the model ignores them, the custom instructions below.

### Local stdio

`bin/ultrathink-connector` runs the connector on your machine over stdio for any client that starts MCP servers as processes. It has no planner, no OAuth and no network access: the client's own model does the planning through nine tools (the six client-driven tools and the three connector tools; `ultrathink_uplift` is not offered), and the six prompts and the graph card resource are served as on the hosted server. It needs Bun 1.2 or later (see [Finding Bun](../configuration.md#finding-bun)).

The stdio server reads only client-driven sessions. If `ULTRATHINK_STATE_DIR` points at the hosted server's directory, `ultrathink_sessions` lists server-mode jobs that `ultrathink_graph` and `ultrathink_result` cannot show.

| Setting | Meaning |
|---|---|
| `ULTRATHINK_STATE_DIR` | Where sessions are kept. Default: the `connector` directory under the host state directory, which is `~/.claude/ultrathink/connector` unless `CLAUDE_CONFIG_DIR` or another host's variables say otherwise. A path inside a `.planning` tree is ignored. |
| `ULTRATHINK_LOG_LEVEL` | `info`, `warn` or `error`. Default `warn`. Logs go to stderr, never stdout, and never contain request text. |

Claude Desktop reads local servers from `claude_desktop_config.json`. Open it from the Claude menu: **Settings**, then **Developer**, then **Edit Config**. The Model Context Protocol documentation gives the location as `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows (`https://modelcontextprotocol.io/docs/develop/connect-local-servers`); it names no Linux path, so use **Edit Config** there. Paths in the file must be absolute. Replace the placeholders:

```json
{
  "mcpServers": {
    "ultrathink": {
      "command": "<path-to-clone>/bin/ultrathink-connector",
      "args": [],
      "env": { "ULTRATHINK_STATE_DIR": "<path-to-state-directory>" }
    }
  }
}
```

On Windows there is no shell wrapper. Run Bun on the entry file directly:

```json
{
  "mcpServers": {
    "ultrathink": {
      "command": "bun",
      "args": ["<path>\\services\\ultrathink\\stdio\\main.ts"],
      "env": { "ULTRATHINK_STATE_DIR": "<path-to-state-directory>" }
    }
  }
}
```

That is `bun <path>\services\ultrathink\stdio\main.ts`. If Claude Desktop cannot find `bun`, give the full path to `bun.exe` as the command. Claude Code can start the same process with `claude mcp add --transport stdio ultrathink -- <path-to-clone>/bin/ultrathink-connector`. Claude Desktop writes the server's stderr to `mcp-server-ultrathink.log` in its log directory, `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows. Checking the server by hand is in the [runbook](../ops/runbook-ultrathink.md#13-connector-surface-and-diagnostics). That a local-server entry shows the six prompts and the card in Claude Desktop is not verified.

## Copy-paste configs by client

The sections above explain each client. This section is the short version: one block per client with placeholders, and for each one the variables its transport actually reads. Replace `<path-to-clone>` with the absolute path of your checkout, `<path-to-state-directory>` with a directory you own (the connector creates it with mode 0700) and `<your-origin>` with the origin of your own [self-hosted service](self-host.md). Nothing here is a real value. Where your variables belong for each shape is in [Bring your own variables](bring-your-own-variables.md).

There are two transports, and they read different variables:

- **Stdio connector** (`bin/ultrathink-connector`, started by the client as a process). It reads no config file, no credential store and no `.env` file (`bin/run-bun` starts Bun with `--no-env-file`, which Bun 1.3.3 and later honour), and it makes no network call. Its settings come only from the environment the client gives the process. Those are the variables in the table below.
- **Hosted service** (`https://<your-origin>/mcp`, OAuth). The client side reads no ultrathink variable: you give the client a URL and sign in on the consent page with the owner password. The variables belong to the service and its operator; see [Self-host](self-host.md).

| Stdio variable | Used for |
|---|---|
| `ULTRATHINK_STATE_DIR` | Where sessions are kept. Set it in every config below. A path inside a `.planning` tree is ignored. When it is unset, the directory is the `connector` directory under the host's state directory (next rows). |
| `ULTRATHINK_LOG_LEVEL` | `info`, `warn` or `error`; default `warn`. Logs go to stderr. |
| `ULTRATHINK_HOST` | Forces which host's state directory is the default: `claude-code`, `grok-build`, `hermes`, `muse`, `omp`, `prime-agent` or `cursor`. Any other value is ignored. Only matters when `ULTRATHINK_STATE_DIR` is unset. |
| `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, `GROK_SESSION_ID`, `MUSE_TOOL_USE_ID`, `MUSE_PLUGIN_ID`, `PRIME_AGENT_CODING_AGENT_DIR`, `RLM_SESSION_DIR` | Host detection when `ULTRATHINK_HOST` is unset: any Grok marker means Grok Build, a Muse marker Muse, a Prime Agent marker Prime Agent; otherwise Claude Code. |
| `HOME`, `CLAUDE_CONFIG_DIR`, `GROK_PLUGIN_DATA`, `GROK_HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` | Where the default state directory is, per detected host (see [State directories](../configuration.md#state-directories)). Only used when `ULTRATHINK_STATE_DIR` is unset. |
| `BUN`, `BUN_INSTALL`, `PATH` | `bin/run-bun` looks for Bun with them (see [Finding Bun](../configuration.md#finding-bun)). |

Host detection never returns Omp from the environment, so inside an Omp shell the default stays the Claude Code directory unless `ULTRATHINK_HOST=omp` is set. Setting `ULTRATHINK_STATE_DIR` in the client's config avoids the question.

### Config for Claude Desktop

Stdio, in `claude_desktop_config.json` (location and Windows form are under [Local stdio](#local-stdio)):

```json
{
  "mcpServers": {
    "ultrathink": {
      "command": "<path-to-clone>/bin/ultrathink-connector",
      "args": [],
      "env": {
        "ULTRATHINK_STATE_DIR": "<path-to-state-directory>",
        "ULTRATHINK_LOG_LEVEL": "info"
      }
    }
  }
}
```

Variables read: `ULTRATHINK_STATE_DIR` and `ULTRATHINK_LOG_LEVEL` from the `env` block, and the stdio table above. Hosted: use the [custom connector](#claude-desktop-and-claudeai-custom-connector) with `https://<your-origin>/mcp`; it reads no variable.

### Config for Claude Code

Stdio, with the environment passed by `-e` (the name comes before `-e`, and `--` ends the options):

```bash
claude mcp add --transport stdio ultrathink -e ULTRATHINK_STATE_DIR=<path-to-state-directory> -- <path-to-clone>/bin/ultrathink-connector
```

Hosted, with OAuth (then run `/mcp` inside Claude Code and authenticate), and with the connector key header instead:

```bash
claude mcp add --transport http ultrathink https://<your-origin>/mcp
claude mcp add --transport http ultrathink https://<your-origin>/mcp --header "x-connector-key: $ULTRATHINK_CONNECTOR_KEY"
```

Run only one of the two hosted commands for the same name. Variables read: the stdio form reads `ULTRATHINK_STATE_DIR` (and the stdio table above); the hosted forms read none on the client, and the header form uses the key in your shell variable `ULTRATHINK_CONNECTOR_KEY`, which the service's `ULTRATHINK_CONNECTOR_KEY` must match. *Not verified:* these commands in a live Claude Code; the `-e` form follows Claude Code's documented `claude mcp add` syntax.

### Config for Cursor

Stdio, the same `mcpServers` JSON as Claude Desktop, in Cursor's MCP configuration. This repository's own setup writes MCP servers for Cursor to `~/.cursor/mcp.json` ([Install](../install.md)), so that file is where to paste it:

```json
{
  "mcpServers": {
    "ultrathink": {
      "command": "<path-to-clone>/bin/ultrathink-connector",
      "args": [],
      "env": {
        "ULTRATHINK_STATE_DIR": "<path-to-state-directory>"
      }
    }
  }
}
```

Variables read: the `env` block and the stdio table above. *Not verified:* the Cursor settings menu that opens the same file, that Cursor starts the connector with this entry, and whether Cursor can complete this server's OAuth sign-in (use stdio for Cursor).

### Config for Grok Chat

Hosted only: in grok.com/connectors choose **New Connector**, **Custom**, enter `https://<your-origin>/mcp`, choose OAuth, and approve with the owner password (full steps under [Grok Chat](#grok-chat)). Grok Chat runs in xAI's cloud, so it cannot start a local stdio process. Variables read on the client: none. Grok caches the tool list at connect time, so reconnect after the service's tools change.

### Config for Omp

This repository is already an Omp plugin (`package.json` names `src/host/omp.ts` as its extension), and the plugin plans in-process without the connector. To also give Omp the connector's nine tools, start `bin/ultrathink-connector` as a stdio process through Omp's MCP file, `~/.omp/agent/mcp.json` (`$PI_CODING_AGENT_DIR/mcp.json` when that variable is set), the file this repository's `scripts/mcp-register.ts` writes for Omp:

```json
{
  "mcpServers": {
    "ultrathink": {
      "type": "stdio",
      "command": "<path-to-clone>/bin/ultrathink-connector",
      "args": [],
      "env": { "ULTRATHINK_STATE_DIR": "<path-to-state-directory>", "ULTRATHINK_HOST": "omp" }
    }
  }
}
```

Variables read: the `env` block and the stdio table above; `ULTRATHINK_HOST=omp` only matters if you drop `ULTRATHINK_STATE_DIR`. *Not verified:* that Omp passes an `env` key to a stdio server (this repository's writer emits only `type`, `command` and `args`). If it does not, run the connector through `env` instead: `"command": "env"` and `"args": ["ULTRATHINK_STATE_DIR=<path-to-state-directory>", "<path-to-clone>/bin/ultrathink-connector"]`. Hosted from Omp is not covered here.

## Use it

Type `/ultrathink` followed by the request, in one message:

```text
/ultrathink design a rate limiter for the public API, with per-key and per-IP limits
```

What happens next:

1. The chat model calls `ultrathink_uplift` with everything after `/ultrathink`, verbatim. The reply has a `sessionId` and a status, normally `running`. The call waits up to 15 seconds in case the plan finishes fast.
2. The model calls `ultrathink_result` with the `sessionId`. Each call waits up to 40 seconds by default (at most 45) and reports `running` if the plan is not ready. The model calls it again until the status is `planned`. No other work is needed from the model meanwhile, and you do not need to answer anything during this wait.
3. When the status is `planned`, the result text is the plan. The model asks you the questions in it that matter, or states the defaults it assumes, and then carries out the plan.

If the request is empty (`/ultrathink` alone), the model should ask for a request and call no tool.

With server-side planning the plan text starts with the Graph of Thought x Chain of Thought block: a wave tree in a code block, then a Mermaid diagram. The model is told to show the tree to you first, unchanged. In a client that draws MCP Apps, the card is bound to the `ultrathink_uplift` call: it shows progress, polls `ultrathink_result` itself and then draws the graph, so the model does not need `ultrathink_graph` for the same session unless you ask for it.

The request is limited by the 1 MB request body, which applies first over HTTP, and by `ULTRATHINK_MAX_INPUT_CHARS` (default 4,000,000 characters).

### Brief and full

`ultrathink_result` takes a `detail` argument:

| Value | Result |
|---|---|
| `brief` (default) | The request, the specification, each Graph of Thought node with its question and conclusion, and the clarifying questions with defaults. Limited to 40,000 characters. |
| `full` | The same plus the numbered Chain of Thought steps of every node. Limited to 80,000 characters. |

When the plan does not fit, whole sections are left out and a note says so. The required parts (request, specification, questions) are kept ahead of the Graph of Thought waves. The structured result has `truncated: true` in that case. Ask the model for `detail: "full"` only when you want the reasoning steps: a large result uses more of the chat's context, and Claude Code warns above 10,000 tokens for one tool result.

### Time and cost

A plan makes 9 to 11 model calls: uplift 1, graph 1, Chain of Thought one per node (5 to 8), clarify 1. Each call is a `claude -p` child process on the owner's Claude plan login, so a plan draws the plan's usage limits (the 5-hour session and the weekly limit) and has no per-token bill. Timing on this path has not been measured on the hosted service; earlier measurements were taken through OpenRouter, which was retired from the hosted service, and they no longer apply. The default planning model is `claude-haiku-5-5`; another Claude model is one `ULTRATHINK_PLANNING_MODEL` change. The result's `usage` field reports the real calls and tokens of each plan. The server logs every model call (`planner_call`) and exposes `ultrathink_planner_calls_total` and `ultrathink_planner_call_duration_seconds`, which show which calls are slow.

Two optional ceilings bound the spend, both counted in tokens by a ledger in the server's database. Both are off (0) by default:

- `ULTRATHINK_RUN_TOKEN_CEILING` (default 0, no limit) for one plan.
- `ULTRATHINK_DAILY_TOKEN_CEILING` (default 0, no limit) for one UTC day, across all plans.

A plan that would pass a ceiling stops with `budget_exceeded`. With no output cap set (`ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS` at 0), each model call's reply is also capped to the tokens the ceilings still allow after its input, and a call whose input alone does not fit is refused with `budget_exceeded`. Abandoned reservations keep counting, so the ledger errs toward stopping early.

The server runs at most `ULTRATHINK_MAX_CONCURRENT_PLANS` plans at once (default 2). It cancels a model call after `ULTRATHINK_MODEL_TIMEOUT_MS` and a whole plan after `ULTRATHINK_PLAN_TIMEOUT_MS` when those are set above 0; both are off by default.

## Commands and the typed /ultrathink

A typed `/ultrathink` is only text. A custom MCP server cannot register a slash command, and no client turns the text into a command by itself. The connector reaches the model on four layers, and each client uses a different subset:

1. **Tool descriptions.** `ultrathink_uplift` (or `ultrathink_plan`) is described as the entry point for `/ultrathink`, and the three connector tools state the trigger for `/ultrathink-think`, `/ultrathink-last`, `/ultrathink-status` and every other `/ultrathink-<name>`: everything after the command is the request, verbatim. This works in any client that shows the model the tool list, so it is the layer to rely on in Claude chat and Grok Chat.
2. **Server `instructions`.** The same routing, delivered to Claude Code. Hosted Claude does not deliver it (issue 93); whether Grok Chat does is not verified.
3. **MCP prompts.** Six prompts, one per supported command (see the [command table](../commands.md#connector)). A prompt returns text for the client to send and runs no tool. Claude Code lists them as `/mcp__ultrathink__<name>`; Claude chat lists them only as "+" menu attachments.
4. **A plugin or custom instructions.** The Claude plugin bundle adds the commands to Claude chat's "/" menu. For Grok Chat, and for Claude without the plugin, paste the text below.

Of the 22 commands the plugin knows, six work on the connector: `/ultrathink`, `/ultrathink-plan`, `/ultrathink-think`, `/ultrathink-last`, `/ultrathink-status` and `/ultrathink-quick`. The other 16 need a plugin host (git, a shell, trackers, local Teachable Moments state) or have no meaning in chat. Typing one makes the model call `ultrathink_command`, which answers with the reason and what to do instead.

For Grok, paste this into Grok's custom instructions (Settings, Customize; the label varies by app version):

```text
When a message starts with /ultrathink, use the ultrathink connector. The request is everything after the command, verbatim. Call ultrathink_uplift with it as prompt. If the status is running, call ultrathink_result with the sessionId, and call it again until the status is planned. Do not invent a sessionId or a status. When the plan is ready, show the user its wave tree first, unchanged, in a code block, ask the questions in the plan that matter, state the defaults you assume for the rest, and carry out the plan. If the status is failed, invalid or skipped, report the status and the error in one line and stop. If nothing follows /ultrathink, ask for a request and call no tool.
A message that starts with /ultrathink- and a command name is another command, not a request to plan. /ultrathink-think [sessionId] [node] calls ultrathink_graph. /ultrathink-last calls ultrathink_graph with no arguments (newest planned session), then ultrathink_result with that sessionId. /ultrathink-status calls ultrathink_sessions with no arguments. /ultrathink-quick <message> is answered directly, with no ultrathink tool. Any other /ultrathink-<name> calls ultrathink_command with command set to the name and args set to the rest, verbatim; relay its message and make the tool call it names in next.
```

For Claude, paste the same text into the instructions of a Claude Project that has the ultrathink connector switched on. For Claude Code, add it to `CLAUDE.md`, or use the prompt route.

If server-side planning is off (no `ultrathink_uplift` in the tool list), the first paragraph does not apply. Use the client-driven text in [Connect Grok Bot to ultrathink](../ops/grok-bot-setup-ultrathink.md) section 9 in its place and keep the second paragraph.

### What is not verified

- Anything about a live connection. The connector has not been connected to Claude chat, Claude Code or Grok Chat, so no step above was seen working in those products.
- Whether Claude's "/" menu lists the plugin's commands for this connector, whether `$ARGUMENTS` is filled in when chat loads a command as a skill, and whether the Connectors tab accepts the owner-password sign-in. These follow Anthropic's plugin documentation.
- Whether Grok Chat or Claude hand the model `structuredContent`, `_meta`, or the server's instructions. Only Claude Code's behavior is documented.
- Whether the MCP App card renders inside Claude or Grok. The card was run in a real headless Chrome through a host harness that implements the MCP Apps specification (handshake, themes, 360 to 1000 px widths, keyboard navigation, a content security policy with `connect-src 'none'`), not inside either product. Real hosts may differ.
- Whether Claude chat or Grok Chat renders a fenced Mermaid block. The Mermaid source was parsed and rendered with Mermaid 11 in strict mode for twelve graphs, including hostile ones, but that says nothing about those two products.
- Which protocol revision Claude chat and Grok Chat open with, and how they react to the 400 on a 2026-07-28 probe. The fallback was confirmed only for the official SDK clients.
- Grok Chat's redirect addresses on iOS, Android and Tesla, its tool-result size limit, per-call timeout and tool description length limit, and whether it uses client ID metadata documents.
- That the model follows a typed `/ultrathink`. This is a convention that the descriptions, the prompts and your custom instructions encourage. A model can still answer the request directly without calling a tool. Say "use ultrathink" or run the prompt when that happens.
- Which model a hosted client uses. The server cannot see it, and server-side mode does not depend on it: the planning model is the server's own (a Claude model on the owner's plan login).

To check a client, send `/ultrathink plan a short test feature` and look for an `ultrathink_uplift` call in the chat, then `ultrathink_result` calls, then a plan that starts with a wave tree and ends with questions. Then send `/ultrathink-status` and look for an `ultrathink_sessions` call.

## Security

- **Owner password.** Only the owner can approve a client. The owner password is an argon2id hash in `ULTRATHINK_OWNER_PASSWORD_HASH`. The consent login allows 5 attempts per IP per 15 minutes. Anyone who knows the password can connect a client, so do not reuse it.
- **Tokens.** Authorization codes are single-use and live 60 seconds. Access tokens last 1 hour and refresh tokens 30 days. Refresh tokens rotate on each use, and a spent one revokes its grant. Tokens are bound to the `/mcp` resource.
- **Revoking.** A client can revoke its own token at `POST /oauth/revoke` (RFC 7009). To revoke every client and token, stop the service, delete `/var/lib/ultrathink/oauth.json`, and start it again (`systemctl stop ultrathink-web`, `rm /var/lib/ultrathink/oauth.json`, `systemctl start ultrathink-web`). Every client then registers and asks you to approve again. Plans are not lost. To lock out the owner login, rotate the hash (runbook section 6).
- **Connector key.** The legacy `x-connector-key` header (`ULTRATHINK_CONNECTOR_KEY`) is for Grok Bot, which cannot do OAuth, and for Claude Code (`--header`). It works on `/mcp` next to OAuth. Do not paste it into Grok Chat or Claude chat: neither client's connector UI can send it. Rotate it in [the Grok Bot guide](../ops/grok-bot-setup-ultrathink.md) section 5.
- **Browser origins.** `/mcp` refuses a request whose `Origin` header is not the server's own origin, `https://claude.ai`, `https://claude.com`, `https://grok.com`, `https://console.x.ai` or an origin in `ULTRATHINK_ALLOWED_ORIGINS`. A request with no `Origin` header (native and server-side clients) is allowed.
- **Where your text goes.** In server-side mode the request and the model's intermediate text go to Anthropic through the owner's Claude plan (and to xAI if the operator enabled the Grok fallback), under the owner's account terms. The server stores the request, the prompts and the plan under `/var/lib/ultrathink` (`journal/`, `sessions/`, `jobs/`) for 30 days by default. Do not send secrets in a request.
- **Logs.** The server logs one JSON line per request: request id, HTTP method and path, status, duration, JSON-RPC method, tool name, the `MCP-Protocol-Version` header as sent, auth kind and client address. It does not log prompt text, plans, the owner password, tokens, the connector key or authorization headers; fields with such names are dropped by the logger.
- **Credentials.** The Claude token (`CLAUDE_CODE_OAUTH_TOKEN`) lives in `/etc/ultrathink/ultrathink.env`, and the `claude` child process receives only an allowlisted environment, so no other server secret reaches it.

## Configuration

The operator sets these in `/etc/ultrathink/ultrathink.env` and restarts the service. The server refuses to start on an invalid value and names the variable. The source is `services/ultrathink/config/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `ULTRATHINK_PUBLIC_ORIGIN` | none (required) | Public origin of the service, `https://ultrathink.swcstudio.space`. `http://` is allowed only for localhost and 127.0.0.1. |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | none (required) | Argon2id hash of the owner password. |
| `ULTRATHINK_SESSION_SECRET` | none (required) | Secret for web login sessions, at least 32 characters. |
| `ULTRATHINK_STATE_DIR` | `/var/lib/ultrathink` | State directory: database, `oauth.json`, `journal/`, `sessions/`, `jobs/`. |
| `ULTRATHINK_PORT` | `8795` | Listen port, 1024 to 65535. |
| `ULTRATHINK_MAX_INPUT_CHARS` | `4000000` | Longest request in characters; `0` means no limit. The 1 MB request body limit applies first over HTTP. |
| `ULTRATHINK_MAX_ANSWER_CHARS` | `20000` | Longest client-driven answer, 1 to 20000 characters. |
| `ULTRATHINK_RUN_TOKEN_CEILING` | `0` | Token limit for one plan; `0` means no limit. A plan over a positive limit stops with `budget_exceeded`. With no output cap set, each model reply is capped to the tokens this limit still allows, and to at most 16000. |
| `ULTRATHINK_DAILY_TOKEN_CEILING` | `0` | Token limit per UTC day across all plans; `0` means no limit. With no output cap set, each model reply is capped to the tokens this limit still allows, and to at most 16000. |
| `ULTRATHINK_SERVER_PLANNING` | unset | `1` turns server-side mode on, through the service user's Claude plan login (`claude -p`; single owner only; see the runbook section "Plan backend (coding-plan inference)"). Unset or `0` means client-driven mode. |
| `ULTRATHINK_PLANNING_MODEL` | `claude-haiku-5-5` | Optional. A Claude model id only; a value with a slash (an OpenRouter-style id) stops the server at start. |
| `ULTRATHINK_PLANNING_FALLBACK` | `none` | `none` or `grok`; read only when server-side mode is on. |
| `ULTRATHINK_PLAN_CONCURRENCY` | `2` | 1 to 6; read only when server-side mode is on. Most `claude` child processes at once. |
| `ULTRATHINK_MAX_CONCURRENT_PLANS` | `2` | Plans that run at once, 1 to 8. More starts return `busy`. |
| `ULTRATHINK_MODEL_TIMEOUT_MS` | `0` | Timeout for one model call; `0` means no timeout. A positive value must be 5000 to 600000. A call that times out is not retried. |
| `ULTRATHINK_PLAN_TIMEOUT_MS` | `0` | Timeout for one whole plan; `0` means no timeout. A positive value must be 30000 to 1800000. |
| `ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS` | `0` | Output token limit for one model call. `0` sends no configured cap: with no token ceiling set, the provider's own maximum applies; with a token ceiling set, each reply is capped to the tokens the ceilings still allow after its input, and never above 16000. A positive value is always sent as the cap; it must be 256 to 32000. |
| Server-side Jev decisions | off | Off until their spend is metered. The hosted service uses no OpenRouter key: OpenRouter was retired from it. |
| `ULTRATHINK_CONNECTOR_KEY` | unset | Key for the `x-connector-key` header (Grok Bot), at least 32 characters. |
| `ULTRATHINK_ALLOWED_ORIGINS` | none | Comma list of extra browser origins (http or https) that `/mcp` accepts. |
| `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` | none | Comma list of extra https origins allowed in client redirect URIs. |
| `ULTRATHINK_SESSION_SECRET_PREVIOUS` | unset | Comma list of up to 4 earlier session secrets, each at least 32 characters, for sessions signed before `ULTRATHINK_SESSION_SECRET` was rotated. |
| `ULTRATHINK_PLAINTEXT_LOOPBACK` | `0` | `1` lets the server run without mTLS, for development and local smoke tests only. With `0` or unset, the three `ULTRATHINK_TLS_*` files are required. |
| `ULTRATHINK_TLS_CERT` | unset | Absolute path to the server certificate of the mTLS listener. Set it together with `ULTRATHINK_TLS_KEY` and `ULTRATHINK_TLS_CLIENT_CA`, or not at all. |
| `ULTRATHINK_TLS_KEY` | unset | Absolute path to the private key of the server certificate. Same set rule as `ULTRATHINK_TLS_CERT`. |
| `ULTRATHINK_TLS_CLIENT_CA` | unset | Absolute path to the CA that signs client certificates. Same set rule as `ULTRATHINK_TLS_CERT`. |
| `ULTRATHINK_SPIFFE_TRUST_DOMAIN` | `ultrathink.internal` | SPIFFE trust domain that client certificate identities are checked against when mTLS is on. 1 to 255 characters from a-z, 0-9, `.`, `_` and `-`. |
| `ULTRATHINK_CHAOS` | `0` | `1` arms fault injection at the upstream seam. It also needs `ULTRATHINK_CHAOS_ENV=staging` and `ULTRATHINK_CHAOS_PLAN`. Off otherwise. |
| `ULTRATHINK_CHAOS_ENV` | unset | Must be `staging` whenever `ULTRATHINK_CHAOS=1`. Any other value stops the server from starting. |
| `ULTRATHINK_CHAOS_PLAN` | unset | Absolute path to the fault plan. Required with `ULTRATHINK_CHAOS=1`; refused without it. |
| `ULTRATHINK_BREAKER_FAILURES` | `5` | Failures inside the window that open the upstream circuit breaker, 0 to 100. `0` turns the breaker off. |
| `ULTRATHINK_BREAKER_WINDOW_MS` | `60000` | Window in milliseconds in which breaker failures are counted, 1000 to 3600000. |
| `ULTRATHINK_BREAKER_OPEN_MS` | `30000` | How long an open breaker stays open before its next attempt, in milliseconds, 1000 to 600000. |
| `ULTRATHINK_MAX_INFLIGHT` | `256` | Requests the server handles at once, 1 to 10000. |
| `ULTRATHINK_PRIORITY_RESERVE_PCT` | `25` | Percent of `ULTRATHINK_MAX_INFLIGHT` slots held back as a reserve, 0 to 90. |
| `ULTRATHINK_FAIR_QUEUE_DEPTH` | `16` | Over-budget requests wait in a queue of this depth per priority class, 0 to 1000; a full queue refuses as before. |
| `ULTRATHINK_FAIR_QUEUE_WAIT_MS` | `1500` | Longest wait in milliseconds for a queued request, 1 to 60000; an expired wait refuses as before. |
| `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT` | `50` | Lowest percent of the normal quota that the adaptive quota may reduce to under load, 10 to 100. |
| `ULTRATHINK_LAG_TARGET_MS` | `100` | Lag target in milliseconds that the adaptive quota reacts to, 10 to 5000. |
| `ULTRATHINK_REPLICA_CAPACITY_RPS` | `20` | Requests per second one replica can take. The recommended replica count metric is computed from it, 1 to 100000. |
| `ULTRATHINK_ABUSE_FAILURES_PER_MINUTE` | `20` | Failures per minute that start the abuse penalty ladder, 1 to 10000. |
| `ULTRATHINK_PENALTY_BASE_SEC` | `60` | Length in seconds of the first penalty block, 1 to 86400. |
| `ULTRATHINK_PENALTY_MAX_SEC` | `3600` | Longest penalty block in seconds, 1 to 86400. Must be greater than or equal to `ULTRATHINK_PENALTY_BASE_SEC`. |
| `ULTRATHINK_DRAIN_MS` | `5000` | Wait in milliseconds after shutdown begins and before the server stops, so in-flight work can finish. 0 to 60000. |
| `ULTRATHINK_RETENTION_DAYS` | `30` | Days before the state directory sweep removes old data. `0` turns the sweep off. 0 to 3650. |
| `ULTRATHINK_AUDIT_LOG` | `1` | `1` writes the audit log; `0` turns it off. |
| `ULTRATHINK_AUDIT_ANCHOR_EVERY` | `1000` | Audit records between anchors, 1 to 1000000. |
| `ULTRATHINK_AUDIT_SEGMENT_BYTES` | `67108864` | Audit segment size in bytes, 1048576 (1 MiB) to 4294967296 (4 GiB). |
| `ULTRATHINK_AUDIT_RETENTION_DAYS` | `365` | Days kept for audit segments before they are pruned. `0` turns pruning off. 0 to 36500. |
| `ULTRATHINK_AUDIT_WATCH_MS` | `1000` | Interval in milliseconds for the check that watches the audit file, 100 to 1000. |
| `ULTRATHINK_AUDIT_SINK_QUEUE` | `10000` | Capacity of the audit sink queue in events, 1 to 1000000. |
| `ULTRATHINK_AUDIT_HTTP_URL` | unset | URL of an audit HTTP sink. https, or http to 127.0.0.1 or localhost. No credentials. |
| `ULTRATHINK_AUDIT_HTTP_TOKEN` | unset | Token for the audit HTTP sink. At least 16 printable ASCII characters, no spaces. |
| `ULTRATHINK_AUDIT_SYSLOG` | unset | `host:port` of a syslog audit sink. Host from letters, digits, `.`, `_` and `-`; port 1 to 65535. |
| `ULTRATHINK_AUDIT_RULES` | unset (built-in rules) | JSON array of anomaly rules that replaces the built-in rules. Validated at startup. |
| `ULTRATHINK_AUDIT_KAFKA_REST_URL` | unset | Kafka REST proxy URL of the audit sink. Same URL rules as `ULTRATHINK_AUDIT_HTTP_URL`. Set it together with `ULTRATHINK_AUDIT_KAFKA_TOPIC`. |
| `ULTRATHINK_AUDIT_KAFKA_TOPIC` | unset | Kafka topic of the audit sink. Set it together with `ULTRATHINK_AUDIT_KAFKA_REST_URL`. |
| `ULTRATHINK_OTLP_ENDPOINT` | unset | Base URL of the span collector for OpenTelemetry traces; `/v1/traces` is appended. https, or http to loopback. No credentials, query or fragment. |

Origin lists take bare origins only (`https://host[:port]`, no path, query or fragment). The request body limit is 1 MB and is not configurable. `ULTRATHINK_RETENTION_DAYS` and the backup variables belong to the maintenance job; see the runbook.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| 401 on `/mcp` | No token, an expired or revoked token, or a wrong connector key. A 401 with no token on the first request is normal: it starts the OAuth flow. | Disconnect and reconnect the connector to run OAuth again. For Grok Bot, compare the key. |
| 403 with an `Origin` error from `/mcp` | The request's `Origin` is not in the allow list. | Add the origin to `ULTRATHINK_ALLOWED_ORIGINS` and restart. Check that the request is sent by the client and not by a browser page. |
| 403 `{"error":"forbidden"}` from nginx | The caller reached the origin server directly, not through Cloudflare. | Use the public hostname. |
| Registration fails: redirect URI refused (`invalid_redirect_uri`) | The client's redirect URI is not https on an allowed origin and not loopback. The message lists the allowed origins. | Add the client's redirect origin to `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` and restart, only if you trust that client. |
| 429 | A rate limit fired. nginx allows 120 `/mcp` requests per minute per client address, 30 OAuth requests per minute, and 5 login requests per minute. The app has its own limits on registration (10 per hour), authorize (30 per minute) and token and revoke (60 per minute). | Wait for the `Retry-After` time. Do not poll `ultrathink_result` with `waitSeconds: 0` in a loop. |
| `busy` error from `ultrathink_uplift` | `ULTRATHINK_MAX_CONCURRENT_PLANS` plans are already running. | Wait a minute and call again with the same `sessionId`. The operator can raise the limit. |
| `disabled` or `not_ready` from `ultrathink_uplift` | Server-side mode is off, or the server is shutting down. | Use the client-driven tools (`ultrathink_plan`), or ask the operator to enable server-side planning (`ULTRATHINK_SERVER_PLANNING=1`). |
| Status `failed`, error `budget_exceeded` | The per-run or daily token ceiling was reached. | Wait for the next UTC day, or ask the operator to raise the ceiling. |
| Status `skipped` | The pipeline declined the request, for example one that starts with a slash command or a `raw:` prefix. | State the request as a plain description of the task and call `ultrathink_uplift` again with a new `sessionId`. |
| Status `failed`, error `auth` | The owner's Claude login is missing, expired or revoked. | The operator renews the Claude token (runbook section "Plan backend (coding-plan inference)") and restarts. |
| Status `failed`, error `rate_limited`, `upstream` or `upstream_unavailable` | The Claude plan's usage limit was hit, the `claude` call failed, or the circuit breaker is open after repeated failures. Nothing retries a failed call. | Try again with a new `sessionId`. The operator checks the plan's usage limit and the timeouts. |
| Status `failed`, error `timeout` | One model call took longer than `ULTRATHINK_MODEL_TIMEOUT_MS`, or the whole plan took longer than `ULTRATHINK_PLAN_TIMEOUT_MS`. Both are off by default, so this needs a limit you set. A timeout is not retried: the plan fails with `timeout`. | Raise the limit, or set `ULTRATHINK_PLANNING_MODEL` to a faster Claude model. The cost of the partial run still counts against the ceilings. |
| Status `failed`, error `interrupted` | The service restarted while the plan ran. | Run it again with a new `sessionId`. |
| Status `invalid` | The model produced an incomplete plan. | Run it again, or rephrase the request. |
| Result says `truncated` | The plan was larger than the size limit, so later Graph of Thought sections were left out. | Ask the user for what is missing, or split the request into smaller ones. |
| The model does not call any tool | The client did not act on the typed `/ultrathink`. | Use the MCP prompt, add the custom instructions above, or say "use the ultrathink connector". |
| A tool you expect is missing in Grok Chat | Grok fetches the tool list once and caches it; only re-authenticating the connector refreshes it (xai-org/plugin-marketplace issue 1402). | Disconnect and reconnect the connector, then check the tool list again. |
| The typed `/ultrathink-think` or `/ultrathink-last` starts a plan | The model read the command as `/ultrathink`. | Use the custom instructions text above, or the plugin command, or the prompt. Tell it the message is `/ultrathink-think`, not a request to plan. |
| Registration returns 429 `temporarily_unavailable` | More than 10 registrations per hour from one client address; Claude registers a client on every fresh connection. | Wait for `Retry-After` and connect again. Do not remove and re-add the connector in a loop. |
| The card is empty or missing in a client that should draw it | The host did not mount the `ui://ultrathink/graph` resource. Reports say custom connectors are inconsistent. | Read the wave tree in the result text; it carries the same plan. |

For server-side checks (logs, `/readyz`, metrics), see the runbook section 7.
