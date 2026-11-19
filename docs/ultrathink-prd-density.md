# PRD density: published Codeblocked PRDs

Published count: 48 Codeblocked PRDs on Linear SPE-35034–SPE-35081, linked to the tracked Notion Uplifted Prompts. This does not close phase 114 criterion 7 (a finished Sub Issue closes its Linear issue and its Notion step row), which is not verified: no end-to-end run has passed and Notion returned `403 restricted_resource` (see `milestones/v1.24-phases/114-tree-of-thought-prds-on-the-selected-model-placed-inside-the/114-VERIFICATION.md`).

## Evidence table

| Count | Linear sub-issue block | Notion link | Source | Status |
|---|---|---|---|---|
| 48 PRDs published | SPE-35034–SPE-35081: 48 rows (Q01–Q48), PRD-SPE-35034–PRD-SPE-35081, Version 1 | Linked to the tracked Notion Uplifted Prompts (Task, Issue and Sub-Issue rows in the `Agent Task Graph` database; the `Uplifted Prompt` property is capped and the full XML is stored under `sessions/<id>.xml`) | Assignment ground truth; `.planning/sync-queue.md` inventory (48 rows); `docs/how-to/code-blocked-prds.md#where-prds-live`; `src/track/plan.ts:168`; `docs/how-to/set-up-notion.md` | Published (count). Per-issue hashes and round-trip verification are not claimed here. |
| Uplifted XML placement | Each PRD sits inside its Sub Issue element as `<PRD key=... model=...>`; the Sub Issue keeps `identifier`, `url` and `notionUrl`; `<PRDS>` carries counts and the model id | Same Sub Issue element carries the Notion link | `docs/how-to/code-blocked-prds.md` (Where PRDs live); phase 114 criterion 5 (PR #236) | Verified by merged code and tests. |
| Linear block form | A managed region in the Sub Issue description: `<!-- ultrathink:prd:start key=K hash=H -->`, a `## PRD` heading and the PRD, then `<!-- ultrathink:prd:end -->`; text outside the region is kept. Over 50,000 characters goes to a linked Linear document with a `[Full PRD]` link. | Only URLs, status summary and the PRD hash flow between Linear and Notion. | `docs/how-to/code-blocked-prds.md` (Linear row) | Accepted. |
| Notion block form | The Sub Issue page body receives the PRD as blocks between two marker callouts carrying the key and hash (100 blocks per request, 2,000 characters per segment). | Rows live in the database created by `notion init` (`Agent Task Graph`); the sync skill writes the PR columns on the rows. | `docs/how-to/code-blocked-prds.md` (Notion row); `docs/how-to/set-up-notion.md` | Accepted. Writes were blocked by 403 at the recorded verification. |

## What remains unverified

- Phase 114 criterion 7: no Sub Issue has been run end to end through closure. Owner step: once Notion is restored, run one Sub Issue through to closure and check its Linear issue and Notion step row (`114-VERIFICATION.md`, Human items).
- Phases 110, 111, 112 and 114 remain `human_needed`. Phase 113 passed 2026-11-18. See `.planning/ROADMAP.md` and `.planning/STATE.md`.
- gsd-core acceptance of the new `<PRD>` child elements inside `<SUBISSUE>` is out of this repository and unconfirmed.

## Source note on planning counts

`.planning/prd-density.md` reports density as 0/48 and `.planning/sync-queue.md` reports 0 applied, 0 synced, 48 queued. Both are gitignored local-only planning records for N4 (no live Linear or Notion writes in that lane). They predate the publication above and need reconciliation by the integration lane; they are not the current published count. Do not read them as proof that no PRD is published, and do not read this page as proof that closure works.
