# Write code-blocked PRDs (Tree of Thought)

After the plan exists as a Graph of Thought (GoT) and each node's rationale is split into Chain of Thought (CoT) steps, the Tree-of-Thought (ToT) stage writes one **code-blocked PRD** per CoT Sub Issue: a short, fixed-shape hand-off with the files to touch, the signatures, an implementation sketch in code blocks and a test skeleton. This guide covers the pipeline, the PRD template, where a PRD ends up in Linear and Notion, which model writes it, and how to resume an interrupted run.

- [The pipeline](#the-pipeline)
- [The PRD template](#the-prd-template)
- [How a PRD is written](#how-a-prd-is-written)
- [Where PRDs live](#where-prds-live)
- [Model routing](#model-routing)
- [The completion gate and PRDs](#the-completion-gate-and-prds)
- [Resume](#resume)
- [Settings](#settings)

## The pipeline

| Stage | Output | Model |
|---|---|---|
| GoT | The graph: nodes (the tasks of the plan) | The model you selected |
| CoT | Each node's numbered rationale steps. With tracking on, a node is a tracker Issue and a step is a Sub Issue | The model you selected |
| ToT | One PRD per Sub Issue, keyed `nodeId.step` | The cheapest allowed model, or the selected one (see [Model routing](#model-routing)) |

GoT and CoT never leave the selected model: `resolveStageModel` returns it for them without reading any config, and `assertCheapPathAllowed` throws for any stage but `tot` (`src/route/cheapest-model.ts`). A ToT PRD is a request built from one Sub Issue: its key, graph id, node id, step number, title and the CoT step's text (`PrdRequest`, `src/think/tot/types.ts`).

## The PRD template

Every PRD has exactly these sections, in this order (`PRD_SECTIONS`, `src/think/tot/template.ts`). The template is the only way a PRD becomes markdown, so a model cannot add, drop or reorder a section.

| Section | What it holds |
|---|---|
| `Objective` | One paragraph: what the Sub Issue must achieve. Not empty. |
| `Acceptance Criteria` | Checkbox bullets (`- [ ] ...`), at least one. |
| `Affected Files/Modules` | One bullet per path, at least one. |
| `Interfaces/Signatures` | One bullet per signature, or `_No new or changed interfaces._`. |
| `Implementation Shape` | A note that code blocks are illustrative unless tagged verified, then at least one fenced code block with a language tag. |
| `Test Skeleton` | A fenced code block. |
| `Assumptions` | Everything the PRD proposes but the repository does not show, or `_None._`. |
| `Link to the CoT Sub Issue` | The Sub Issue key, graph id, node id and step, and its URL when the tracker already has one. |

Rules the validator (`validatePrd`) enforces:

- Every bullet in `Affected Files/Modules` and `Interfaces/Signatures` carries `[verified]` or `[assumption]`. `[verified]` means the path or symbol exists in the repository; the project facts decide the tag, never the model's own claim.
- At most 150 lines and 6 000 characters (`DEFAULT_PRD_LIMITS`).
- Balanced, language-tagged code fences.
- The Link section names the Sub Issue key.
- No secret-shaped value (key, token, credential, private key).

A path or symbol that is not in the repository keeps its place but is tagged `[assumption]` and is also listed in `Assumptions`. A path that leaves the repository root is dropped and noted there too.

## How a PRD is written

1. **Inspect the project** (`src/think/tot/inspector.ts`). A bounded, read-only walk lists file names and reads declared symbol names (functions, classes, types and so on) from source files. File contents never leave the inspector. It never follows a symlink, and skips VCS and dependency folders and anything that looks like a credential (`.env*`, `*.pem`, `*.key`, `id_rsa`, `secrets`, `credentials`, `token` names). The default limits are depth 6, 2 000 files, 64 KiB read per file and 4 000 symbols. The facts are built once per run and shared by every PRD.
2. **Ask the model** (`src/think/tot/generator.ts`). The model gets the Sub Issue and the relevant slice of the facts, both escaped so repository or tracker text cannot forge structure, and answers with one JSON object. The reply is shape-checked, grounded against the facts, rendered through the template and validated. A rejection goes back to the model as feedback: up to 3 model calls per PRD.
3. **Fall back.** When all attempts fail validation, a PRD built from the Sub Issue text alone is used instead (`renderFallbackPrd`). It says in `Assumptions` that nothing in it is verified, and the record is marked `fallback` with the reason. If even the fallback fails validation, the PRD is `failed`.
4. **Run the pool** (`src/think/tot/runner.ts`). Up to 4 PRDs run at once (at most 16). A failing model call is retried up to 3 times with jittered backoff. One PRD failing never stops the others. Each finished PRD is checkpointed to disk before it counts, and a `manifest.json` with the totals (`total`, `generated`, `failed`, `fallbacks` and one record per PRD) is written when the run settles.

## Where PRDs live

A PRD is attached to the Sub Issue CoT already made; the sync never creates a Sub Issue (`src/track/prd-sync.ts`). A PRD whose Sub Issue is not known yet stays `pending` until a later run knows it.

| Where | What you see |
|---|---|
| **Linear** | The Sub Issue's description gets a managed region: `<!-- ultrathink:prd:start key=K hash=H -->`, a `## PRD` heading and the PRD, then `<!-- ultrathink:prd:end -->`. Your own text around the region is kept. A PRD over 50 000 characters (a limit that is not documented by Linear; the constant is `DEFAULT_LINEAR_INLINE_LIMIT`) goes to a Linear document linked to the issue, and the description carries a short summary and a `[Full PRD]` link. |
| **Notion** | The Sub Issue's page body gets the PRD as blocks (fenced code becomes a code block in a Notion-supported language, anything else `plain text`), between two marker callouts that carry the key and hash. Block and rich-text limits are respected: 100 blocks per request, 2 000 characters per text segment. |
| **State directory** | `prd-sync/<graphId>/` under the host's state directory holds the secret-redacted local copy of each PRD (`<key>-<hash8>.md`) and `ledger.json`. The ledger holds, per PRD and tracker, a status (`pending`, `synced`, `failed`), the hash last written, ids, URLs, attempt counts and a failure class. It holds no PRD text and no error text. |

Sync is idempotent. The PRD is written locally and its hash put in the ledger before any tracker call. A re-run skips a PRD whose region already carries the same hash, and rewrites a changed PRD in place between its markers. A write that stopped halfway in Notion leaves its block ids in the ledger and the next run removes them first. Tracker calls retry 429, 5xx and timeouts with jitter raised to `Retry-After`; other 4xx errors are not retried. A tracker with no configuration is skipped with the reason `not-configured`. The report lists, per PRD, what each tracker did (`created`, `updated`, `skipped`, `failed`, `pending`) and a summary of `synced`, `pending` and `failed`.

Secret-shaped values are masked before a PRD is stored or uploaded, and the report notes when that happened (`redacted`).

## Model routing

ToT writes many small structured documents, so it may run on a cheaper model than the one you selected. `resolveToTModel` (`src/route/cheapest-model.ts`) picks the model; the first hit wins:

1. **Your override**, `models.tot.model`, used as written.
2. **The host's own model list**, when the caller supplies one: the cheapest allowlisted entry of the selected model's provider.
3. **The candidate list** for that provider, `models.tot.candidates`, cheapest first.
4. **The selected model.**

Steps 2 and 3 only offer a model that is on the allowlist (every id in `models.tot.candidates`), is reported available by the host and answers a one-time smoke check. A candidate that fails any of these is skipped. If none passes, the selected model is used and the reason says why.

At run time (`createToTRouter`) a failing item retries once on the selected model. After `models.tot.breakerThreshold` consecutive cheap-model failures (default 3) the whole stage moves to the selected model. A cheap success resets the count and a cancelled call never counts. Each decision logs one structured line with host, provider and model ids, never keys or prompts.

### What a host cannot do

Routing needs a host that lets each call name its own model (`TOT_HOST_PER_CALL_MODEL`, `src/route-defaults.ts`):

| Host | Picks a model per call |
|---|---|
| Claude Code, Grok Build, Hermes, Muse | yes |
| Omp, Prime Agent, Cursor | no: they bind one session model |

On a host that cannot, ToT keeps the selected model and the decision carries a `warning:` reason; `models.tot.model` is ignored there and the warning says so. A caller that knows better can pass the capability in explicitly.

The built-in candidates (`TOT_PRD_CANDIDATES`) are: Anthropic `claude-haiku-5-5`, xAI `grok-build-0.1`, OpenAI `gpt-5-mini` then `gpt-5-nano`, Cursor `cursor-small`. The Anthropic and xAI ids are the ones this repository already sends on its legacy routes. The OpenAI and Cursor ids are unverified placeholders that were not checked against any provider catalog. A wrong id does no harm: the smoke check drops it and the stage runs on the selected model.

## The completion gate and PRDs

On Omp the [completion gate](../architecture.md#omp-native-planning) holds the session until the whole plan exists, and when the ToT stage ran, that includes its PRDs. A PRD that ended `failed` makes the plan partial (`prds_failed`), and fewer generated PRDs than the plan promised makes it short (`prds_short`). A partial plan is shown but not injected until you confirm with `proceed`, or until `ULTRATHINK_GATE_ALLOW_PARTIAL` is set. A PRD the model could not write but the fallback did is counted as generated and is flagged `fallback` in the manifest.

## Resume

Nothing is lost when a run is interrupted:

- **Generation.** Run the stage again with the same checkpoint directory. A PRD whose input hash is unchanged (the Sub Issue's key, graph, node, step, title and CoT text, the template version, and the caller's `inputSalt`, which is where anything else that should change a PRD, such as the model, goes) is read back from its checkpoint and reported `resumed`; only the rest is written. A changed Sub Issue, a new salt or a newer template regenerates just that PRD. A cancelled run marks PRDs that never started `skipped` and keeps every PRD it finished.
- **Sync.** `resumePrds` (`src/track/prd-sync.ts`) re-sends only what the ledger still owes, from the local copies, so it needs neither the model nor the original run. A tracker the ledger shows as `synced` is left alone, whatever its hash.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `models.tot.model` | `""` | Explicit ToT model, used as written. Blank means no override. A blank in a later layer clears an earlier one. |
| `models.tot.candidates` | the built-in lists above | An object mapping a provider family (`anthropic`, `openai`, `xai`, `cursor`) to a cheapest-first list of model ids. A list replaces that provider's list, an empty list removes the provider, and every listed id is on the allowlist. |
| `models.tot.breakerThreshold` | `3` | Consecutive cheap-model failures after which the whole stage runs on the selected model. An integer of at least 1. |

A value of the wrong type keeps the value from the lower layer. Prototype-polluting provider names (`__proto__`, `constructor`, `prototype`) and names with control characters are ignored in every layer.

The environment variables `ULTRATHINK_GATE`, `ULTRATHINK_GATE_INACTIVITY_MS` and `ULTRATHINK_GATE_ALLOW_PARTIAL` belong to the completion gate and are listed in [environment.md](../environment.md).
