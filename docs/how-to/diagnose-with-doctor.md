# Diagnose with doctor

`ultrathink doctor` checks your config files, the credentials your enabled features need, the state directory and the tools ultrathink runs on, then prints what it found. It is static and offline: it reads files on this machine and sends nothing anywhere.

Use it first when planning, tracking or ship does less than you expect. ultrathink fails open, and its config merge ignores a misspelled key or an out-of-range value without a word, so a typo such as `ship.autoMerg` looks exactly like a feature that is not working. doctor is where those silent cases become visible.

`<clone>` is the directory you cloned ultrathink into.

- [Run it](#run-it)
- [What it checks](#what-it-checks)
- [What it never does](#what-it-never-does)
- [Reading the report](#reading-the-report)
- [Exit codes and `--json`](#exit-codes-and---json)
- [Worked examples](#worked-examples)
- [What to run next](#what-to-run-next)

## Run it

```sh
<clone>/bin/ultrathink doctor
```

Run it from the project you have the problem in: the project file `<cwd>/.claude/ultrathink.json` is read from the current directory. The state directory is the one `bin/ultrathink status` shows, so set `ULTRATHINK_HOST` to check another host, for example `ULTRATHINK_HOST=omp <clone>/bin/ultrathink doctor`.

## What it checks

The report has six sections, always in this order.

| Section | What doctor looks at |
|---|---|
| `runtime` | Bun 1.2 or later (error below that), `git` on `PATH` (error when missing), `gh` on `PATH` (a warning only while `ship.enabled` is on, otherwise info), and Python 3.10 or later (info only: just the Hermes and Prime Agent hosts need it). It also names the detected host. For `gh` it reports whether `GH_TOKEN` or `GITHUB_TOKEN` is set or a gh hosts file exists, and says that authentication is not verified. |
| `config` | The three config files, lowest precedence first: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`, `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink.json` and `<cwd>/.claude/ultrathink.json`. See below. |
| `credentials` | For each feature your config switches on, whether its provider has a credential. Providers are named as present or missing and nothing more. |
| `inference` | The Claude and Grok logins planning runs on: the `claude` CLI and its version, the auth method it reports, an `ANTHROPIC_API_KEY` that planning ignores, the Grok session, the Claude to Grok fallback, the effective models and the pinned memory-bank chain. See [Inference](#inference). |
| `state` | The state directory: whether it exists and is writable, how many session records it holds and how large they are, which files other users can read, and leftover temporary and lock files. |
| `pstack` | The Cursor bridge: whether it is enabled and which user file decided that (a project file cannot enable it), the resolved pstack plugin path and version, each stage's skills (a warning for a mapped name with no `SKILL.md`), and whether the `beforeSubmitPrompt` hook is installed. Info when the bridge is off. See [Run pstack skills beside GSD in Cursor](use-pstack-with-cursor.md). |

### Config files

Each file is checked over the accumulated lower-precedence layers using the same merge ultrathink uses. Doctor never changes that merge. For every file:

| Finding | Level | Meaning |
|---|---|---|
| not found | info | The file is optional. |
| not valid JSON, not readable, or top level is not an object | error | Every key in the file is ignored. The finding shows the path and the parser's message, never the file's content. |
| unknown section, unknown key | warn | The merge ignores it. When a known name is close (an edit distance of 2 or less, or the same first four letters) the finding says `Did you mean …?`. |
| `<key> ignored: expected <type>, got <type>` | warn | The value has the wrong type, so the lower layer's value or the default stays. |
| `<key> invalid: contains a control character` | warn | A nonblank host provider/model selector or provider-default model contains a control character and will be rejected by model resolution. Whitespace-only resets keep their normal meaning. |
| `<key> ignored or adjusted: effective value is <value>` | warn | The type is right but the value is outside what the merge accepts (a range, an allowed word, a shape), so the effective value is the one shown. |
| `decisions.enabled ignored: Jev is always on; …` | warn | `decisions.enabled` has no effect in any file. Set `ULTRATHINK_DECISIONS=0` to turn Jev off. |
| `<key> ignored in a project file by design` | info | The key is one a file inside a cloned repository may not set, or may only tighten, such as `hindsight.url`, `teach.recallLimit` or `decisions.zdr: false`. Put it in your own config if you want it. See [Share config with a team or a project](team-and-project-config.md). |

Doctor knows built-in sections and keys plus supported optional backend fields. `models.hosts` entries must use a supported host id and hold only `provider` and `model` strings. `models.providerDefaults` takes provider names with string values, except reserved keys such as `__proto__`, `constructor` and `prototype`. Nonblank selectors containing control characters are diagnosed rather than silently trimmed.

A key you wrote with the value it already defaults to is not a finding.

### Credentials

Only features that are switched on are checked:

| Feature | Provider |
|---|---|
| `ship.enabled` (unless `ULTRATHINK_SHIP=0`) and `hitl.knowledgeBase` | Greptile |
| `notion.dataSourceUrl` set | Notion |
| `linear.team` set | Linear |
| `hindsight.enabled` (unless `ULTRATHINK_HINDSIGHT=0`) | Hindsight in direct mode; Desk gateway when its selected backend is gateway |
| `ragflow.enabled` (unless `ULTRATHINK_RAGFLOW=0`) | RAGFlow in direct mode; Desk gateway when its selected backend is gateway |
| `substrate.backend: "gateway"` (unless `SUBSTRATE_DISABLED=1`) | Desk gateway |
| Jev, unless `ULTRATHINK_DECISIONS=0` | an OpenRouter or Vercel AI Gateway key |

A missing credential for a feature you turned on is a warning, with the command that stores it, for example `bin/ultrathink-mcp auth set-key greptile --stdin`. Jev without a key is only info, because it fails open and skips its decision points. A present credential is reported as `credential present` with its source, either the credential store or the name of the environment variable.

Three Jev findings are specific to the OpenRouter key, which ultrathink uses for Jev only:

| Finding | Level | Meaning and fix |
|---|---|---|
| `OPENROUTER_API_KEY is exported: Ultrathink no longer reads it …` | warn | The generic name is not read any more; Jev takes its key from the credential store or `ULTRATHINK_OPENROUTER_KEY`. The export only lets other tools in this environment (SDKs and agents read that name on their own) spend the key. Fix: remove the export from your shell profile or service unit. |
| `Jev decisions: OPENROUTER_API_KEY is set but Ultrathink no longer reads it` | warn | Jev has no key and only the legacy variable is set. Fix: `bin/ultrathink-mcp auth set-key openrouter --stdin`, then remove the export. |
| `decisions.health` (title: `Jev unavailable: …`) | warn | A persisted Jev health breaker is open: a rail (`OpenRouter` or `Vercel AI Gateway`; each has its own breaker) answered HTTP 402 (insufficient credits) or 401/403 (key rejected). The finding names the rail, the cause, the date it opened, that rail's own fix and the next check time. Decisions use their defaults until then; the plan gate plans every prompt. Fix the cause (top up, or store a valid key), then run `bin/ultrathink decisions check`; `ok` closes the breaker (the line ends with `breaker closed`). |

### State directory

| Finding | Level |
|---|---|
| The directory does not exist yet | info (it is created on the first planned prompt) |
| The directory exists but is not writable, or the path is not a directory | error |
| Number, total size and oldest age of the session records in `sessions/` | info |
| More than 500 session records, or more than 100 MB | warn, with the hint `ultrathink prune --older-than 30 --dry-run` |
| Session, carrier, control or last files that group or others can read | warn, with the fix `chmod -R go-rwx <dir>`. ultrathink writes new files with mode `0600`. |
| `*.tmp` or `*.lock` regular files in the state root or `sessions/` older than one hour | warn: possible write leftovers. Pruning still preserves a strict `last.json` lock whose PID is alive. |

### Inference

The `inference` section looks at the two coding-plan logins that planning runs on: Claude first, Grok as the opt-in fallback. The plan is the plan holder's own login; Anthropic does not permit routing other people's requests through plan credentials. Doctor starts two local commands, `claude --version` and `claude auth status --json`, and makes no network request itself. When `claude.auth` is `"plan"` it runs the second one with the same environment the planning child gets, minus `ANTHROPIC_API_KEY` and the other scrubbed variables. A probe that cannot run skips its finding; it is never an error. Doctor prints a variable's name, never its value.

| Finding | Level | Meaning |
|---|---|---|
| `claude <v>` | ok | The `claude` CLI is installed and new enough for `claude.model`. `claude-haiku-5-5` needs 2.1.293, `claude-sonnet-5-5` 2.1.284, `claude-opus-5-5` 2.1.280. |
| `claude CLI not found: the Claude route cannot plan` | warn | No `claude` on `PATH`. Install Claude Code. |
| `claude <v> is older than <min>, which <model> needs` | warn | Fix: `claude update`. |
| `Claude auth: plan login (<plan>)` | ok | `claude auth status` reports a claude.ai login. |
| `Claude auth: no plan login` | warn | Run `claude` and sign in with `/login`, or run `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`. |
| `Claude auth: API key (claude.auth is api-key)` | info | You opted into the key. A warning follows when neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` is set. |
| `ANTHROPIC_API_KEY is set and ignored for planning (claude.auth is plan)` | info | Planning ignores it, but an interactive `claude` still uses it and bills the API. Unset it where your shell or service sets it. |
| `Grok login: <account> expires in <age>` | ok | A signed-in, unexpired Grok session. |
| `Grok login expired` | warn | Fix: `ultrathink grok login`. When `grok.home` is set, the fix names the lane: `GROK_HOME=<dir> grok login --device-auth`. |
| `Grok login: not signed in` | warn or info | A warning when `claude.fallbackToGrok` is on or the engine resolves to Grok, with the fix `ultrathink grok login` (and `GROK_HOME=<dir> grok login --device-auth` when `grok.home` is set); otherwise info, because the Grok route is not in use. |
| `Grok route uses a shunt gateway` | info | The `shunt` transport has no login to check. |
| `Claude to Grok fallback: off` or `on (models …)` | info | The state of `claude.fallbackToGrok` and the Grok models the fallback would walk. |
| `Models: claude …, grok …` | info | The effective models, with `then …` and the fallback models when you set `grok.fallbackModels` (empty by default). A detail says when `claude.model` is pinned in config rather than the route default. |
| `Memory-bank inference: claude-haiku-5-5, then grok-build-0.1` or `… claude-haiku-5-5 only` | info | The chain that memory-bank calls (the Teachable Moments distiller behind `teach observe`) use. It is pinned in code: `claude-haiku-5-5` first, then `grok-build-0.1` only when `claude.fallbackToGrok` is on and the Grok lane is usable; the detail gives the reason when the fallback is missing. Details also say that Hindsight needs no inference (chunks mode) and name any configured `claude.model`, `grok.model` or `grok.fallbackModels` that differ from the chain, for example `claude.model claude-sonnet-5-5 applies to planning and helpers, not to memory-bank calls`. Memory-bank calls never use Sonnet, `grok-4.7` or OpenRouter. |

## What it never does

- It makes no network request and starts neither `gh` nor `curl`. The only programs it starts are `claude --version` and `claude auth status --json`, both local (see [Inference](#inference)). It does not run `gh auth status`, which contacts GitHub. Whether a token works is something only a live probe can tell you (see [What to run next](#what-to-run-next)).
- It never prints a credential: not the value, not a prefix of it, not its length. Effective URL values omit username/password before formatting; every line also passes through shared secret redaction.
- It never opens a session record. It only looks at their names, sizes, ages and permissions, and it prints none of the names.
- It never writes or deletes anything and never changes your config.

## Reading the report

```text
ultrathink doctor
runtime
  ✓ Bun 1.2.19
  ✓ git found on PATH
  ✓ gh found on PATH
  i gh credentials: a gh hosts file exists
      Authentication is not verified offline: doctor never runs gh.
  ✓ Python 3.12
  ✓ Detected host: claude-code
config
  i user config: not found (optional)
      File: /home/you/.config/ultrathink/config.json
  ✓ Claude user config: valid, nothing unknown or ignored
      File: /home/you/.claude/ultrathink.json
  i project config: not found (optional)
      File: /home/you/work/app/.claude/ultrathink.json
credentials
  i Jev decisions: no OpenRouter or Vercel AI Gateway key
      Decision points are skipped without one; planning continues.
      fix: bin/ultrathink-mcp auth set-key openrouter --stdin (or vercel)
inference
  ✓ claude 2.1.301
  ✓ Claude auth: plan login (max)
  i ANTHROPIC_API_KEY is set and ignored for planning (claude.auth is plan)
      Other tools, including an interactive claude, still use it and bill the API
      fix: Unset it where your shell or service sets it
  ✓ Grok login: you@example.com expires in 6d
  i Claude to Grok fallback: off (claude.fallbackToGrok is false)
  i Models: claude claude-haiku-5-5, grok grok-build-0.1
  i Memory-bank inference: claude-haiku-5-5 only
      Hindsight needs no inference (chunks mode)
state
  ✓ State directory is writable: /home/you/.claude/ultrathink
  i 12 session records, 96.4 KB, oldest 9 days old
0 errors, 0 warnings
```

| Marker | Level | Meaning |
|---|---|---|
| `✓` | ok | Checked and fine. |
| `i` | info | Worth knowing; nothing to fix. |
| `!` | warn | Something is ignored, missing or growing. Planning still works, but not the way you wrote it. |
| `✗` | error | Something is broken. A file cannot be read, a required tool is missing, or the state directory is not writable. |

Detail lines are indented under their finding, and a `fix:` line gives the command or edit that resolves it.

## Exit codes and `--json`

| Exit | Meaning |
|---|---|
| 0 | No error finding. Warnings are allowed, so read the report even when the exit code is 0. |
| 1 | At least one error finding. |
| 2 | A usage error. The only accepted argument is `--json`. |

`--json` prints one JSON object on one line instead of the text:

```json
{"ok":true,"summary":{"error":0,"warn":1,"info":3,"ok":6},"findings":[{"id":"config.user.unknown-key.ship.autoMerg","section":"config","level":"warn","title":"user config: unknown key ship.autoMerg","detail":"The key is ignored by the merge. File: /home/you/.config/ultrathink/config.json","fix":"Did you mean ship.autoMerge?"}]}
```

The keys and their order are fixed: `ok` (true when there is no error finding), `summary` (counts for `error`, `warn`, `info` and `ok`), and `findings` in section order. Each finding has `id` (stable, for example `config.project.unknown-key.ship.autoMerg`), `section`, `level` and `title`, plus `detail` and `fix` when it has them.

## Worked examples

### A misspelled key

Ship never merges, and you are sure `ship.autoMerge` is set. The report says:

```text
config
  ! user config: unknown key ship.autoMerg
      The key is ignored by the merge. File: /home/you/.config/ultrathink/config.json
      fix: Did you mean ship.autoMerge?
```

The file says `"autoMerg": true`, so the key never took effect and `ship.autoMerge` stayed `false`. Fix the spelling in that file. Section typos are reported the same way, for example `unknown section shipp` with `Did you mean ship?`.

### An out-of-range value

You set `hitl.maxQuestions` to 9 in the project file and still get the default number of questions:

```text
config
  ! project config: hitl.maxQuestions ignored or adjusted: effective value is 4
      The written value is outside what the merge accepts (type, range or allowed values). File: /home/you/work/app/.claude/ultrathink.json
```

`hitl.maxQuestions` takes a whole number from 1 to 4. Anything else is ignored and the earlier value stays, here the default 4. Change the value to one in range.

### Loose permissions

Session records hold your prompts and plans. If the state directory was created by an older version or copied from somewhere else, other users on the machine may be able to read it:

```text
state
  ✓ State directory is writable: /home/you/.claude/ultrathink
  i 340 session records, 4.2 MB, oldest 41 days old
  ! 340 session or carrier files readable by group or others
      They hold your prompts and plans. New files are written with mode 0600.
      fix: chmod -R go-rwx /home/you/.claude/ultrathink
```

Run the `chmod` shown in the `fix:` line. Run doctor again to confirm the warning is gone.

## What to run next

Doctor tells you what is wrong on this machine. It cannot tell you whether a service answers or a key works. For that, run the live probe for the feature you are debugging. Each one sends requests to the service:

| Question | Command |
|---|---|
| Do the Notion, Linear and Greptile credentials work? | `<clone>/bin/ultrathink-mcp check` |
| Does Jev reach its model with your key? | `<clone>/bin/ultrathink decisions check` |
| Is the Hindsight server up? | `<clone>/bin/ultrathink hindsight check` |
| Does RAGFlow answer, and which datasets can the key see? | `<clone>/bin/ultrathink ragflow check` |
| Is `gh` logged in? | `gh auth status` |

For symptoms by name, see [Troubleshooting](../troubleshooting.md). The commands are listed in [Commands](../commands.md#binultrathink-doctor).
