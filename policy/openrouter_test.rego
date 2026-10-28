
# Tests for policy/openrouter.rego. Inline fixtures in the shape policy/collect.ts emits. Assertions use exact sets of
# [rule, file] pairs. Only O-* rules are compared, because the other rule files share the `violations` set.
package ultrathink.policy

import rego.v1

# Every allow-listed file, each referencing OpenRouter as it does in the tree: the baseline that must pass.
allowed_sources := [{"file": file, "refs": ["host"]} | some file in object.keys(openrouter_allowed)]

sources_input(sources) := {"sources": sources}

openrouter_summary(vs) := {[v.rule, v.file] | some v in vs; startswith(v.rule, "O-")}

test_o_baseline_allowed_files_pass if {
	vs := violations with input as sources_input(allowed_sources)
	openrouter_summary(vs) == set()
}

test_o_allow_list_has_no_services_entry if {
	every file in object.keys(openrouter_allowed) {
		not startswith(file, "services/")
	}
}

test_o_r1_new_host_reference_fails if {
	extra := [{"file": "src/new.ts", "refs": ["host"]}]
	vs := violations with input as sources_input(array.concat(allowed_sources, extra))
	openrouter_summary(vs) == {["O-R1", "src/new.ts"]}
}

test_o_r1_detail_names_every_kind if {
	extra := [{"file": "src/new.ts", "refs": ["env", "symbol"]}]
	vs := violations with input as sources_input(array.concat(allowed_sources, extra))
	details := {v.detail | some v in vs; v.file == "src/new.ts"}
	details == {"src/new.ts: OpenRouter is for Jev decisions only (env, symbol)"}
}

test_o_r1_service_file_fails if {
	extra := [{"file": "services/ultrathink/engine/openrouter.ts", "refs": ["symbol"]}]
	vs := violations with input as sources_input(array.concat(allowed_sources, extra))
	openrouter_summary(vs) == {["O-R1", "services/ultrathink/engine/openrouter.ts"]}
}

test_o_r1_file_without_refs_is_ignored if {
	extra := [{"file": "src/clean.ts", "refs": []}]
	vs := violations with input as sources_input(array.concat(allowed_sources, extra))
	openrouter_summary(vs) == set()
}

test_o_r1_stale_allow_list_entry_fails if {
	remaining := [source | some source in allowed_sources; source.file != "src/mcp/cli.ts"]
	vs := violations with input as sources_input(remaining)
	openrouter_summary(vs) == {["O-R1", "src/mcp/cli.ts"]}
}

test_o_r1_allow_listed_file_with_empty_refs_is_stale if {
	other := [source | some source in allowed_sources; source.file != "src/mcp/cli.ts"]
	quiet := [{"file": "src/mcp/cli.ts", "refs": []}]
	vs := violations with input as sources_input(array.concat(other, quiet))
	openrouter_summary(vs) == {["O-R1", "src/mcp/cli.ts"]}
}
