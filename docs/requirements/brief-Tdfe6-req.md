# Cleaned Brief: Swarm×Ultrathink Race (Tdfe6-req)

Correlation: `dfe6b075-b574-47af-9556-0c7845221d85`
Status: redacted copy. PII scan: 0 findings, no regimes hinted. Ambiguity: 0.25 (flagged term: may), no clarification round required.

## Stakeholder quotes (redacted text is the only copy that leaves intake)

- Michael: "we need injection logic that forces the plan into the session regardless of orchestration state, plus force-stop logic for orchestration while waiting on Uplift."
- Symptom: "when we run our magic words in Omp it tends to subagent the work which starts our Swarms orchestration which stops the plan from dropping into the chat when it's complete since the orchestration starts before the plan completes logically and basically stops the uplifted plan from injecting."
- Requirement: "Once a new prompt enters the runtime it should allow orchestration to stop or finish off."

## Constraints carried into the spec

- FORCE-INJECTION: on uplift completion the full prompt lands in the session even with orchestration mid-flight; TODO list updates; session continues.
- FORCE-STOP: a new user prompt stops or cleanly finishes running orchestration; no killing mid-write; bounded graceful drain.
- ORDER GATE: Swarm subagent dispatch starts only after the prompt injection is confirmed.
- Production grade: explicit failure states, no silent drops (log + retry the injection), no prompt loss.
- Assumption A1: the truncated tail "no prompt" is read as "no prompt loss", matching requirement 4's "no silent drops".

## Open questions

None blocking. The order-gate vs force-injection interaction (gate holds dispatch until injection confirmed, injection never waits on orchestration) is resolved in the spec as a hard rule.
