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
