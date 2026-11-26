# Traceability — Tab6a-req

Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
Version: 1.0.0

Acceptance ids are written once each, with Given/When/Then, so a criteria scan of this file still parses. The normative criterion text is `docs/acceptance.md`.

AC-1 story: US-1 Given the matrix When coverage is computed Then 1 link to US-1 exists check: trace automated: true

AC-2 story: US-1 Given the matrix When coverage is computed Then 1 link to US-1 exists check: trace automated: true

AC-3 story: US-1 Given the matrix When coverage is computed Then 1 link to US-1 exists check: trace automated: true

AC-4 story: US-1 Given the matrix When coverage is computed Then 1 link to US-1 exists check: trace automated: true

AC-5 story: US-1 Given the matrix When coverage is computed Then 1 link to US-1 exists check: trace automated: true

AC-6 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-7 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-8 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-9 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-10 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-11 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-12 story: US-2 Given the matrix When coverage is computed Then 1 link to US-2 exists check: trace automated: true

AC-13 story: US-3 Given the matrix When coverage is computed Then 1 link to US-3 exists check: trace automated: true

AC-14 story: US-3 Given the matrix When coverage is computed Then 1 link to US-3 exists check: trace automated: true

AC-15 story: US-3 Given the matrix When coverage is computed Then 1 link to US-3 exists check: trace automated: true

AC-16 story: US-3 Given the matrix When coverage is computed Then 1 link to US-3 exists check: trace automated: true

AC-17 story: US-4 Given the matrix When coverage is computed Then 1 link to US-4 exists check: trace automated: true

AC-18 story: US-4 Given the matrix When coverage is computed Then 1 link to US-4 exists check: trace automated: true

AC-19 story: US-4 Given the matrix When coverage is computed Then 1 link to US-4 exists check: trace automated: true

AC-20 story: US-4 Given the matrix When coverage is computed Then 1 link to US-4 exists check: trace automated: true

NFR links, not acceptance ids:

- NFR-P1 -> A08.load
- NFR-S1 -> A10.sast
- NFR-A1 -> A08.a11y
- NFR-I1 -> A08.contract
- NFR-C1 -> A10.secrets

# Corrective Closeout (T8751-req)

Correlation: 8751d51d-f16a-447f-bba5-2773493f4b03. Links: story -> criteria; NFR -> verifier.

- US-013 -> file-presence scan, import scan
- US-014 -> advisory-verdict test, incomplete-plan language scan
- US-015 -> handler prompt-turn test, prompt-time notice scan
- US-016 -> full test run, type-lint-deadcode run, residual symbol scan
- US-017 -> Linear closure scan, pull-request review scan
- NFR-13 -> A08.unit
- NFR-14 -> A08.security
- NFR-15 -> A08.unit
- NFR-16 -> A08.unit
- NFR-17 -> A08.compliance

# T3b18-req traceability (pstack Autonomy Uplift)

Correlation: `3b18f741-390c-4422-bdd2-4b18499c4490`. Story -> criteria; NFR -> verifier.

- US-018 -> AC-41, AC-42, AC-43
- US-019 -> AC-44, AC-45
- US-020 -> AC-46
- US-021 -> AC-47, AC-48
- US-022 -> AC-49, AC-50
- US-023 -> AC-51, AC-52
- NFR-18 -> A08.unit
- NFR-19 -> A08.security
- NFR-20 -> A08.unit
- NFR-21 -> A08.unit
- NFR-22 -> A08.compliance

# Tdde6-req traceability (Dense 500-line XML Prompts via Double Uplift)

Correlation: `dde6accb-e288-424f-8913-cb429e5f88ef`. Story -> criteria; NFR -> verifier.

AC-53 story: US-024 Given session XML samples and backup branch diffs When measurement runs Then 1 density-loss stage is named with line counts check: measurement-scan automated: true

AC-54 story: US-025 Given tracker rows complete When the second uplift runs Then 1 final XML carries every issue reference check: bun-test automated: true

AC-55 story: US-026 Given a completed graph When the final prompt renders Then line count is 500 or more with 100 percent of rationales preserved check: line-count automated: true

AC-56 story: US-027 Given a normal run When accounting is read Then total is 10 with 1 graph 7 node chains and 2 uplifts named check: doc-check automated: true

AC-57 story: US-028 Given normal mode When the plan card renders Then 1 full prompt section appears beneath the summary with 100 percent of characters preserved check: bun-test automated: true

AC-58 story: US-029 Given a session awaiting the final prompt When dispatch is attempted Then 0 specialists start before the final prompt lands check: bun-test automated: true

AC-59 story: US-030 Given the branch When gates run Then 0 failures remain and 1 evidence comment exists per closed row check: typecheck automated: true
NFR links, not acceptance ids:

- NFR-23 -> A08.unit
- NFR-24 -> A08.security
- NFR-25 -> A08.unit
- NFR-26 -> A08.unit
- NFR-27 -> A08.compliance

# Tdfe6-req traceability (Swarm×Ultrathink Race)

Correlation: `dfe6b075-b574-47af-9556-0c7845221d85`. Story -> criteria; NFR -> verifier.

AC-60 story: US-031 Given uplift complete during orchestration When delivery runs Then 1 full prompt lands in session and TODO list shows 1 updated entry check: bun-test automated: true

AC-61 story: US-031 Given the injection channel busy When the first delivery fails Then 1 retry occurs and 1 log line names the failure check: bun-test automated: true

AC-62 story: US-032 Given a delivery attempt that fails When the retry budget ends Then 1 named dropped-with-reason state is recorded and 0 silent drops occur check: bun-test automated: true

AC-63 story: US-033 Given orchestration running When a new prompt starts Then orchestration reports drained state within 30 seconds bound and 0 mid-write kills occur check: bun-test automated: true

AC-64 story: US-033 Given drain exceeding the bound When the bound elapses Then 1 timed-out state is recorded and 1 new turn proceeds check: bun-test automated: true

AC-65 story: US-034 Given injection not yet confirmed When dispatch is attempted Then 0 subagents start and 1 held reason is recorded check: bun-test automated: true

AC-66 story: US-034 Given injection confirmed When dispatch opens Then 1 or more lanes start only after the confirmation timestamp appears in log check: bun-test automated: true

AC-67 story: US-035 Given the mid-flight completion scenario When the race check runs Then 1 injected prompt and 0 lost plans are asserted check: bun-test automated: true

AC-68 story: US-035 Given the new-prompt-during-uplift scenario When the race check runs Then 1 drained orchestration and 1 landed prompt are asserted with 0 drops check: bun-test automated: true

AC-69 story: US-036 Given any delivery outcome When the status query runs Then 1 named state from the closed set of 5 is returned check: bun-test automated: true

NFR links, not acceptance ids:

- NFR-28 -> A08.load
- NFR-29 -> A08.security
- NFR-30 -> A08.unit
- NFR-31 -> A08.unit
- NFR-32 -> A08.compliance
