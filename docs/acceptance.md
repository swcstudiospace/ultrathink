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

# Acceptance Criteria: pstack Autonomy Uplift (T3b18-req)

Correlation: `3b18f741-390c-4422-bdd2-4b18499c4490`. Format as before: identifier, story link, Given When Then, check tag, automation flag.

AC-41 story: US-018 Given a phase with a resolvable fleet When the phase executes Then 1 playbook from the 4 PLAYBOOK_ROUTES entries is dispatched and 0 second resolvers exist check: bun-test automated: true

AC-42 story: US-018 Given the fleet resolver When the discuss stage runs Then the routed playbook is `investigation` and the roster lists the `how` skill under discuss check: bun-test automated: true

AC-43 story: US-018 Given the plan execute and review stages When each stage runs Then the routed playbooks are `multi-phase-plan` `feature` and `shipping` in that order check: bun-test automated: true

AC-44 story: US-019 Given an absent pstack cache When gsd-autonomous runs Then 1 fallback reason is recorded in the phase SUMMARY and 0 runs stop check: bun-test automated: true

AC-45 story: US-019 Given an explicit override flag When resolution fails Then the phase stops as blocked with 1 named reason and 0 vanilla units run check: bun-test automated: true

AC-46 story: US-020 Given a session before the uplifted prompt lands When dispatch is attempted Then 0 subagents are spawned before the phase PLAN exists check: bun-test automated: true

AC-47 story: US-021 Given a completed phase When the summary emits Then 1 line names the playbook and 1 line names the fleet or fallback and 0 phases lack provenance check: bun-test automated: true

AC-48 story: US-021 Given a wave unit with a missing playbook file When dispatch runs Then that unit stops as blocked with the absent path named and 0 improvised steps run check: bun-test automated: true

AC-49 story: US-022 Given each fleet outcome When resolution completes Then 1 typed state from ok disabled unresolvable forced-off or blocked is returned with 0 empty outcomes check: bun-test automated: true

AC-50 story: US-022 Given a red wave unit When the wave lands Then the phase does not advance and 1 retry inside playbook rules is recorded check: bun-test automated: true

AC-51 story: US-023 Given the branch When bun run check plus biome plus knip plus bun test run Then 0 tsc errors 0 biome findings 0 unused exports and 0 test failures remain check: typecheck automated: true

AC-52 story: US-023 Given the pull request to main When CI completes Then 1 PR exists and 0 CI runs are red at merge time check: ci-scan automated: true

# Acceptance Criteria: Dense 500-line XML Prompts via Double Uplift (Tdde6-req)

Correlation: `dde6accb-e288-424f-8913-cb429e5f88ef`. Format as before: identifier, story link, Given When Then, check tag, automation flag.

AC-53 story: US-024 Given session XML samples and backup branch diffs When measurement runs Then 1 density-loss stage is named with line counts check: measurement-scan automated: true

AC-54 story: US-025 Given tracker rows complete When the second uplift runs Then 1 final XML carries every issue reference check: bun-test automated: true

AC-55 story: US-026 Given a completed graph When the final prompt renders Then line count is 500 or more with 100 percent of rationales preserved check: line-count automated: true

AC-56 story: US-027 Given a normal run When accounting is read Then total is 10 with 1 graph 7 node chains and 2 uplifts named check: doc-check automated: true

AC-57 story: US-028 Given normal mode When the plan card renders Then 1 full prompt section appears beneath the summary with 100 percent of characters preserved check: bun-test automated: true

AC-58 story: US-029 Given a session awaiting the final prompt When dispatch is attempted Then 0 specialists start before the final prompt lands check: bun-test automated: true

AC-59 story: US-030 Given the branch When gates run Then 0 failures remain and 1 evidence comment exists per closed row check: typecheck automated: true

# Acceptance Criteria: Swarm×Ultrathink Race (Tdfe6-req)

Correlation: `dfe6b075-b574-47af-9556-0c7845221d85`. Format as before: identifier, story link, Given When Then, check tag, automation flag.

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
