# Write code-blocked PRDs (Tree of Thought)

After the plan exists as a Graph of Thought (GoT) and each node's rationale is split into Chain of Thought (CoT) steps, the Tree-of-Thought (ToT) stage writes one **code-blocked PRD** per CoT Sub Issue: a short, fixed-shape hand-off with the files to touch, the signatures, an implementation sketch in code blocks and a test skeleton. This guide covers the pipeline, the PRD template, how a PRD is written, where a PRD ends up in Linear and Notion, which model writes it, and how to resume an interrupted run.

- [The pipeline](#the-pipeline)
- [The PRD template](#the-prd-template)
- [How a PRD is written](#how-a-prd-is-written)
- [Where PRDs live](#where-prds-live)
- [Model](#model)
- [The completion gate and PRDs](#the-completion-gate-and-prds)
- [Resume](#resume)
- [Settings](#settings)

## The pipeline

| Stage | Output | Model |
|---|---|---|
| GoT | The graph: nodes (the tasks of the plan) | The model you selected |
| CoT | Each node's numbered rationale steps. With tracking on, a node is a tracker Issue and a step is a Sub Issue | The model you selected |
| ToT | One PRD per Sub Issue, keyed `nodeId.step` | The model you selected (see [Model](#model)) |

A ToT PRD is a request built from one Sub Issue: its key, graph id, node id, step number, title and the CoT step's text (`PrdRequest`, `src/think/tot/types.ts`).

## The PRD template

Every PRD has exactly these sections, in this order (`PRD_SECTIONS`, `src/think/tot/template.ts`). The template is the only way a PRD becomes markdown, so a model cannot add, drop or reorder a section. The template version is 3 (`PRD_TEMPLATE_VERSION`), and it is part of every checkpoint's input hash.

| Section | What it holds |
|---|---|
| `Objective` | One paragraph: what the Sub Issue must achieve. Not empty. |
| `Acceptance Criteria` | Checkbox bullets (`- [ ] ...`), at least one. |
| `Affected Files/Modules` | One bullet per path, at least one. The paths are proposals. |
| `Interfaces/Signatures` | One bullet per signature, or `_No new or changed interfaces._`. The signatures are proposals. |
| `Implementation Shape` | A fixed note that the code blocks are illustrative and were not checked against the repository, then at least one fenced code block. |
| `Test Skeleton` | A fenced code block. |
| `Assumptions` | What the PRD assumes and the model could not confirm from the Sub Issue text, or `_None._`. |
| `Link to the CoT Sub Issue` | The Sub Issue key, graph id, node id and step, and its URL when the tracker already has one. |
| `Code Blocked PRD` | A fixed line: the PRD is blocked until a reviewer confirms the acceptance criteria and approves the Sub Issue for implementation. |

Rules the validator (`validatePrd`) enforces:

- The nine sections, exactly and in order.
- `Objective` is not empty. `Acceptance Criteria` and `Affected Files/Modules` each have at least one bullet.
- `Implementation Shape` and `Test Skeleton` each have a fenced code block. Fences are balanced and language-tagged.
- `Code Blocked PRD` has a line beginning `Blocked until`.
- The Link section names the Sub Issue key.
- At most `think.tot.maxPrdLines` lines and `think.tot.maxPrdChars` characters (defaults 150 and 6 000; `DEFAULT_PRD_LIMITS`).
- No secret-shaped value (key, token, credential, private key).

## How a PRD is written

1. **Ask the model** (`src/think/tot/generator.ts`). The model gets the Sub Issue's key, graph, node, step, title and CoT step text, all escaped so tracker text cannot forge structure. Its system prompt says it cannot read the repository and must write from the Sub Issue text alone. It answers with one JSON object. The reply is shape-checked, rendered through the template and validated. A rejection goes back to the model as feedback: up to 3 model calls per PRD. Anything the model could not confirm from the Sub Issue text goes under `assumptions`.
2. **Fall back.** When all attempts fail validation, a PRD built from the Sub Issue text alone is used instead (`renderFallbackPrd`). Its `Assumptions` say the repository was not read, so no file, interface or scope in it is confirmed. The manifest record is kept as `generated` with `fallback` set and the reason recorded. If even the fallback fails validation, the PRD is `failed`.
3. **Run the pool** (`src/think/tot/runner.ts`). `think.tot.concurrency` PRDs run at once (default 4, 1 to 16). A failing model call is retried up to 3 times with jittered backoff (500 ms base, 8 s cap). One PRD failing never stops the others. Each finished PRD is checkpointed to disk before it counts, and a `manifest.json` with the totals (`total`, `generated`, `failed`, `fallbacks` and one record per PRD) is written when the run settles.

## Where PRDs live

A PRD is attached to the Sub Issue CoT already made; the sync never creates a Sub Issue (`src/track/prd-sync.ts`). A PRD whose Sub Issue is not known yet stays `pending` until a later run knows it.

| Where | What you see |
|---|---|
| **Uplifted XML** | Each PRD sits inside its own Sub Issue element, as `<PRD key=... model=...>` with the escaped markdown inside. The Sub Issue keeps its `identifier`, `url` and `notionUrl` attributes, and carries `status="pending"` until it has a tracker row. The `<PRDS>` element in the ISSUES block keeps its counts and the model id. The uplifted prompt is long because it carries every PRD; that is accepted. |
| **Linear** | The Sub Issue's description gets a managed region: `<!-- ultrathink:prd:start key=K hash=H -->`, a `## PRD` heading and the PRD, then `<!-- ultrathink:prd:end -->`. Your own text around the region is kept. A PRD over 50 000 characters (a limit that is not documented by Linear; the constant is `DEFAULT_LINEAR_INLINE_LIMIT`) goes to a Linear document linked to the issue, and the description carries a short summary and a `[Full PRD]` link. |
| **Notion** | The Sub Issue's page body gets the PRD as blocks (fenced code becomes a code block in a Notion-supported language, anything else `plain text`), between two marker callouts that carry the key and hash. Block and rich-text limits are respected: 100 blocks per request, 2 000 characters per text segment. |
| **State directory** | `prd-sync/<graphId>/` under the host's state directory holds the secret-redacted local copy of each PRD (`<key>-<hash8>.md`) and `ledger.json`. The ledger holds, per PRD and tracker, a status (`pending`, `synced`, `failed`), the hash last written, ids, URLs, attempt counts and a failure class. It holds no PRD text and no error text. |

Sync is idempotent. The PRD is written locally and its hash put in the ledger before any tracker call. A re-run skips a PRD whose region already carries the same hash, and rewrites a changed PRD in place between its markers. A write that stopped halfway in Notion leaves its block ids in the ledger and the next run removes them first. Tracker calls retry 429, 5xx and timeouts with jitter raised to `Retry-After`; other 4xx errors are not retried. A tracker with no configuration is skipped with the reason `not-configured`. The report lists, per PRD, what each tracker did (`created`, `updated`, `skipped`, `failed`, `pending`) and a summary of `synced`, `pending` and `failed`.

Secret-shaped values are masked before a PRD is stored or uploaded, and the report notes when that happened (`redacted`).

## Model

Tree-of-Thought writes each PRD with the model the session selected, on every host. There is no cheaper model for this stage and no ToT model setting, so ToT uses the same model as GoT and CoT. The model id is recorded as `model` on the `<PRDS>` element.

If the session has no selected model, ToT writes nothing: the stage stops with `PRD_NO_SELECTED_MODEL`, and Omp shows the refusal as a warning notice.

## The completion gate and PRDs

On Omp the [completion gate](../architecture.md#omp-native-planning) holds the session until the whole plan is ready. When the ToT stage ran, ready means every PRD is generated, placed on its Sub Issue row and delivered to its tracker. A partial plan is held, with the list of what is missing. Nothing releases a partial plan: there is no way to start it early, and no environment variable overrides the hold. The missing items are reported with these codes:

- `prds_failed`: a PRD ended `failed`.
- `prds_short`: fewer PRDs were generated than the plan promised.
- `prds_sync_failed`: PRDs were not delivered to the tracker.
- `prds_sync_pending`: PRDs are still waiting for the tracker.

A PRD the model could not write but the fallback did is counted as generated and is flagged `fallback` in the manifest.

## Resume

Nothing is lost when a run is interrupted:

- **Generation.** Run the stage again with the same checkpoint directory. A PRD whose input hash is unchanged (the Sub Issue's key, graph, node, step, title and CoT text, the template version, and the caller's `inputSalt`) is read back from its checkpoint and reported `resumed`; only the rest is written. The stage sets `inputSalt` to the PRD limits, because the limits shape every PRD. The model does not, so a rerun on another model keeps the PRDs already written. A changed Sub Issue, new limits or a newer template regenerates just that PRD. A cancelled run marks PRDs that never started `skipped` and keeps every PRD it finished.
- **Sync.** `resumePrds` (`src/track/prd-sync.ts`) re-sends only what the ledger still owes, from the local copies, so it needs neither the model nor the original run. A tracker the ledger shows as `synced` is left alone, whatever its hash.

## Settings

These keys live under `think.tot` in the config layers (`src/config/think.ts`):

| Key | Default | Meaning |
|---|---|---|
| `think.tot.enabled` | unset (on) | Runs the stage whenever tracking made Sub Issue rows. `false` turns it off. |
| `think.tot.concurrency` | `4` | PRDs written at once, 1 to 16. |
| `think.tot.maxPrdChars` | `6000` | Character limit for one PRD, 500 to 100 000. |
| `think.tot.maxPrdLines` | `150` | Line limit for one PRD, 20 to 2 000. |

A value of the wrong type, or outside its range, keeps the value from the lower layer.

The environment variables `ULTRATHINK_GATE` and `ULTRATHINK_GATE_INACTIVITY_MS` belong to the completion gate and are listed in [environment.md](../environment.md).
