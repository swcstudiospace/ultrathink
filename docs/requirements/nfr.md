# NFRs: ToT Removal Program (Tf0b0-req)

Numbering continues from NFR-01..NFR-07 (excision allocation in docs/blueprint-tot-excision.md). Each target states a number with unit and names the verifier.

## NFR-08 — Perf
Kind: perf. Target: The prompt handler returns in 5000 ms or less when planning still runs, and returns 0 STOP texts. Verified by: A08.load.

## NFR-09 — Security
Kind: security. Target: Aside delivery sends 0 secrets and redacts 100% of matched secret patterns, verified by secret scan with 0 findings. Verified by: A08.security.

## NFR-10 — A11y
Kind: a11y. Target: Terminal messages use plain text with 0 color-only meanings and 100% of messages readable without a dialog. Verified by: A08.unit.

## NFR-11 — I18n
Kind: i18n. Target: User messages use en-US text with 0 locale-dependent formats across 100% of shipped strings. Verified by: A08.unit.

## NFR-12 — Compliance
Kind: compliance. Target: Change adds 0 new first-party dependencies and keeps AGPL license for 100% of changed files. Verified by: A08.compliance.

## NFR-13 — Perf (T8751-req)

Kind: perf. Target: Gate validation returns in 1000 ms or less with 0 blocked turns on partial verdicts. Verified by: A08.unit.

## NFR-14 — Security (T8751-req)

Kind: security. Target: Removal sends 0 secrets and redacts 100% of matched secret patterns, verified by secret scan with 0 findings. Verified by: A08.security.

## NFR-15 — A11y (T8751-req)

Kind: a11y. Target: Advisory notes use plain text with 0 color-only meanings and 100% readable without a dialog. Verified by: A08.unit.

## NFR-16 — I18n (T8751-req)

Kind: i18n. Target: User messages use en-US text with 0 locale-dependent formats across 100% of shipped strings. Verified by: A08.unit.

## NFR-17 — Compliance (T8751-req)

Kind: compliance. Target: Change adds 0 new first-party dependencies and keeps AGPL license for 100% of changed files. Verified by: A08.compliance.
