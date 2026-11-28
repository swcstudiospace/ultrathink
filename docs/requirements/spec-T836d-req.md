# Requirements Spec: Uplift Density and Omp UI (T836d-req)

Status: VALIDATED for downstream. Correlation: 836dc01d-3bcb-4957-982f-95d75b1b9593.
Source brief: docs/requirements/brief-T836d-req.md. Stories: docs/requirements/stories.md (US-018..US-022). Criteria: docs/acceptance.md (AC-41..AC-46). NFRs: docs/requirements/nfr.md (NFR-18..NFR-22). Traceability: docs/requirements/traceability.md.

## 1. Scope

Upgrade uplift density (Graph-of-Thought 6-8 nodes, per-node 5-8 steps, 9 prompts total, no truncation in normal mode) and Omp UI (full prompt section beneath existing section; 5 real-store panels). Uplifted prompt carries Linear Issue/Sub-Issue plus Notion links per node; kickoff retains row creation. Verification via bun run check, bun test, biome, knip, PR to main, CI green before merge, Linear/Notion updated.

## 2. Stories (MoSCoW, 5 stories, all Must)

- US-018 dense defaults; US-019 full prompt beneath; US-020 real-store panels; US-021 tracker links per node; US-022 verification and sync. MoSCoW applies (<=20 stories); WSJF rank supplementary is not published (no stakeholder values supplied).

## 3. NFRs

NFR-18 perf, NFR-19 security, NFR-20 a11y, NFR-21 i18n, NFR-22 compliance (all measurable with verified_by). Coverage 1.0 complete true.

## 4. Acceptance

Each criterion is Given/When/Then with check and automated true, Then carries numbers. Manual ratio 0.0; unmeasurable ids [].

## 5. Evidence

- req_pii_scan: found [] has_pii false.
- req_ambiguity_scan (brief): score 0; (NFR targets): score 0.
- req_invest_score US-018..US-022: score 6 each, failed [].
- req_story_duplicates: pair_count 0.
- req_gwt_check: criteria 6 missing_gwt 0.
- req_criteria_testability: total 6 manual_ratio 0 unmeasurable_ids [].
- req_nfr_coverage: coverage 1 complete true.
- req_traceability_coverage: total 10 covered 10 coverage 1 meets_target true.
- req_lint (python + bun): see A01 verification; shared_verdict recorded alongside.

## 6. Assumptions and open questions

- maxChars exact ceiling is implementer-chosen; AC-42 governs (0 truncation markers).
- Merge on CI-green per brief (review infra unavailable).
- .planning authoritative for sync; main repo only for edits.

## 7. Out of scope

Architecture choice (A03), product code, schedule (A01), security-risk acceptance (A10).
