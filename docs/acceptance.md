# Acceptance Criteria: ToT Removal Program (Tf0b0-req)

Format per criterion: identifier, story link, Given When Then, check tag, automation flag.

AC-16 story: US-006 Given a prompt submitted while planning runs When the handler returns Then 0 STOP texts appear and 1 turn starts without a confirm step check: bun-test automated: true

AC-17 story: US-006 Given planning not finished at prompt time When the handler returns Then 1 aside delivery is scheduled and 0 STOP texts are returned check: bun-test automated: true

AC-18 story: US-007 Given a plan that finishes after the prompt turn starts When planning completes Then 1 aside message carries the plan text and the turn count stays 1 check: bun-test automated: true

AC-19 story: US-007 Given a plan ready at prompt time When the handler returns Then 1 inline message carries the plan and 0 aside messages duplicate it check: bun-test automated: true

AC-20 story: US-008 Given a plan that fails the checklist When validation runs Then the session proceeds with 1 advisory note and 0 blocked turns check: bun-test automated: true

AC-21 story: US-008 Given a plan that passes the checklist When release runs Then 1 execution context with matching hash is issued to 1 worker group check: bun-test automated: true

AC-22 story: US-009 Given the source tree When symbol scan runs Then 0 matches for GATE_HOLD gateHoldPartial GATE_WAITING gateWaitingBlocked NO_PLAN planFailedNotice EARLY_RELEASE PENDING remain check: grep-clean automated: true

AC-23 story: US-009 Given omp and gate sources When polling scan runs Then 0 polling timers 0 blocked flags and 0 boundedWait helpers remain check: grep-clean automated: true

AC-24 story: US-010 Given architecture install troubleshooting configuration docs When doc scan runs Then 0 dialog phrases and 0 hold phrases remain check: grep-clean automated: true

AC-25 story: US-010 Given the docs set When doc check runs Then 4 files describe immediate start with aside delivery check: doc-check automated: true

AC-26 story: US-011 Given ToT and Codeblocked PRD issue sets When closure scan runs Then 0 open issues remain for the SPE-35422 to SPE-35427 set and the SPE-35369 to SPE-35375 set check: linear-scan automated: true

AC-27 story: US-011 Given each closed issue When evidence check runs Then 1 evidence comment exists per closed issue and 0 faked closures remain check: linear-scan automated: true

AC-28 story: US-012 Given the branch When type and lint checks run Then 0 errors from tsc and 0 findings from biome and 0 unused exports from knip remain check: typecheck automated: true

AC-29 story: US-012 Given the branch When targeted tests run Then 0 failures in omp and gate suites and 1 green summary line is recorded check: unit-test automated: true

# Acceptance Criteria: Corrective Closeout (T8751-req)

AC-30 story: US-013 Given the branch When file presence scan runs Then 0 of the 4 removed files exist on disk check: grep-clean automated: true

AC-31 story: US-013 Given src scripts and test trees When import scan runs Then 0 imports of the removed module paths remain check: grep-clean automated: true

AC-32 story: US-014 Given a plan that fails tracker-row checks When validateArtifacts runs Then 1 advisory note is reported and 0 blocked turns occur check: bun-test automated: true

AC-33 story: US-014 Given completion-gate and omp sources When incomplete-plan language scan runs Then 0 STOP hold confirm or proceed strings remain on that path check: grep-clean automated: true

AC-34 story: US-015 Given a prompt submitted with pending tracker rows When the handler returns Then 0 tracker-pending notices appear in the prompt-turn message and 1 aside carries the notice check: bun-test automated: true

AC-35 story: US-015 Given the omp prompt path When prompt-time notice scan runs Then 0 tracker-pending notice call sites execute before the turn starts check: grep-clean automated: true

AC-36 story: US-016 Given the branch When full bun test plus tokenOpt standalone run Then 0 failures occur and 1 green summary line is recorded check: unit-test automated: true

AC-37 story: US-016 Given the branch When tsc biome and knip run Then 0 tsc errors 0 biome findings and 0 unused exports remain check: typecheck automated: true

AC-38 story: US-016 Given the source tree When residual symbol scan runs Then 0 references to the removed modules remain outside history and docs check: grep-clean automated: true

AC-39 story: US-017 Given ToT and Codeblocked issue sets When closure scan runs Then 0 open issues remain and 1 evidence comment exists per closed issue check: linear-scan automated: false

AC-40 story: US-017 Given the pull request to main When review scan runs Then 1 plugin-reload note is present and 0 open review threads remain check: review-scan automated: false
