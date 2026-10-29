
# OpenRouter policy (O-R1). Input: the `sources` array of the shared input contract written by policy/collect.ts. Each
# entry is {"file", "refs"}: a non-test source or config file and the reference kinds found in it outside full-line
# comments. Each violation is {"rule", "file", "detail"}.
#
# The owner rule: OpenRouter is for Jev decisions only (src/decisions/**, typesafe/jev through
# https://openrouter.ai/api/alpha/decisions) and the credential plumbing that stores and verifies that one key.
# Everything else (the hosted planner included) runs on the Claude plan login, with Grok Build as the fallback.
#
# Reference kinds (regexes in policy/collect.ts):
#   host      openrouter.ai
#   env       OPENROUTER_API_KEY
#   provider  the quoted provider id "openrouter"
#   symbol    OpenRouterFetch, OpenRouterError, OpenRouterCompleter*, createOpenRouterCompleter, openRouterApiKey,
#             openRouterBaseUrl, ULTRATHINK_OPENROUTER*
#
# The allow-list below was derived by scanning the tree. Nothing under services/ appears in it: the hosted service
# has no OpenRouter path, so any services/ hit is a violation. Tests (*.test.ts), docs and *.md are never scanned.
#
#   file                         kinds             why it references OpenRouter
#   scripts/render-env-docs.ts   symbol            env reference renderer: its head text names the Jev key variable ULTRATHINK_OPENROUTER_KEY
#   src/decisions/cli.ts         provider, symbol  `decisions check` no-key message, provider branch, ULTRATHINK_OPENROUTER_KEY
#   src/decisions/client.ts      host              URL guard: ULTRATHINK_DECISIONS_URL must be openrouter.ai or loopback
#   src/decisions/flow.ts        provider          Jev flow-eval: the openrouter rail's health breaker and unavailable message
#   src/decisions/gate.ts        provider, symbol  resolveOpenRouterKey, the rail/provider resolution, the Jev key variable
#   src/decisions/health.ts      host, provider    per-rail Jev breaker: rail id and the top-up hint at openrouter.ai
#   src/decisions/types.ts       host, provider    DEFAULT_DECISIONS_URL and the DecisionsProvider union
#   src/decisions/usage.ts       provider          Jev usage ledger: the rail recorded on each request
#   src/doctor/env-check.ts      env, symbol       doctor warns when the retired OPENROUTER_API_KEY export is still set
#   src/env-registry.ts          host, symbol      env registry: the Jev key variable and the openrouter.ai Decisions URL rule, for validation and the generated reference
#   src/host/grokbot.ts          host              DECISION_HOSTS: journal replay of Jev responses
#   src/mcp/cli.ts               provider, symbol  `auth set-key openrouter` branch for the Jev key
#   src/mcp/openrouter-key.ts    host              OPENROUTER_KEY_URL, verification of the stored Jev key
#   src/mcp/providers.ts         provider, symbol  key-provider registry: id "openrouter" and the Jev key variable
#   src/route-defaults.ts        env, symbol       scrub list: the Jev key variables never reach model-CLI children
#   src/stack/decisions.ts       env               stack probe: reports a retired OPENROUTER_API_KEY export; no request unless `live`
#   src/uplift/commands.ts       provider, symbol  status line for the Jev provider and its key source
package ultrathink.policy

import rego.v1

openrouter_allowed := {
	"scripts/render-env-docs.ts": "Env reference renderer: head text names the Jev key variable",
	"src/decisions/cli.ts": "Jev: decisions check no-key message and provider branch",
	"src/decisions/client.ts": "Jev: URL guard accepting only openrouter.ai or loopback",
	"src/decisions/flow.ts": "Jev: flow-eval rail breaker and unavailable message",
	"src/decisions/gate.ts": "Jev: resolveOpenRouterKey and provider resolution",
	"src/decisions/health.ts": "Jev: per-rail breaker, rail id and top-up hint",
	"src/decisions/types.ts": "Jev: DEFAULT_DECISIONS_URL and the DecisionsProvider union",
	"src/decisions/usage.ts": "Jev: usage ledger records the rail of each request",
	"src/doctor/env-check.ts": "Doctor warning when the retired OPENROUTER_API_KEY export is still set",
	"src/env-registry.ts": "Env registry: describes the Jev key variable and the openrouter.ai Decisions URL rule; never reads a value",
	"src/host/grokbot.ts": "Jev: DECISION_HOSTS for journal replay of Jev responses",
	"src/mcp/cli.ts": "Jev key: auth set-key openrouter branch",
	"src/mcp/openrouter-key.ts": "Jev key: verification URL for the stored key",
	"src/mcp/providers.ts": "Jev key: provider registry entry and key variable",
	"src/route-defaults.ts": "Scrub list: the Jev key variables are dropped from model-CLI child envs",
	"src/stack/decisions.ts": "Jev: stack probe names the Jev key variables and the retired OPENROUTER_API_KEY export",
	"src/uplift/commands.ts": "Jev: status line for the provider and its key source",
}

# O-R1: a file that references OpenRouter and is not on the allow-list.
violations contains {"rule": "O-R1", "file": source.file, "detail": sprintf("%s: OpenRouter is for Jev decisions only (%s)", [source.file, concat(", ", source.refs)])} if {
	some source in input.sources
	count(source.refs) > 0
	not openrouter_allowed[source.file]
}

# O-R1, stale entry: an allow-listed file that no longer references OpenRouter (or is gone) must leave the list, so
# the list never grants a standing exemption to a file that has no use for it. Iteration runs over the allow-list, not
# the input, so a tree without these files fails closed.
referencing_files := {source.file | some source in input.sources; count(source.refs) > 0}

violations contains {"rule": "O-R1", "file": file, "detail": sprintf("%s is on the OpenRouter allow-list but no longer references OpenRouter: remove it from openrouter_allowed", [file])} if {
	some file in object.keys(openrouter_allowed)
	not file in referencing_files
}
