# Install ultrathink in Hermes

## Requirements

- Hermes Agent v0.23.1 (2026.9.24), observed. Minimum Hermes version: not documented.
- Python 3.10 or later, per the comment in `hosts/hermes/plugin.yaml`.
- A complete checkout. `hosts/hermes/bridge.py` resolves `REPO_ROOT` from its own path, following the links the install creates, and loads skills from `skills/`.

## Install

The manifest lives in `hosts/hermes/`, not the repository root. From the repository root, link the plugin's files into a real plugin directory:

```sh
PLUGIN_DIR=${HERMES_HOME:-$HOME/.hermes}/plugins/ultrathink
if [ -L "$PLUGIN_DIR" ]; then rm "$PLUGIN_DIR"; fi  # an earlier install linked the whole directory: drop that link only
mkdir -p "$PLUGIN_DIR"
for f in "$PWD"/hosts/hermes/*.py "$PWD"/hosts/hermes/plugin.yaml; do
  case "$f" in *_test.py) continue ;; esac
  ln -sf "$f" "$PLUGIN_DIR/"
done
hermes plugins enable ultrathink
```

- Link the files, not the directory. `hermes plugins remove` resolves the plugin directory and refuses one that is a symlink to a path outside `~/.hermes/plugins/` (`Invalid plugin name 'ultrathink': resolves outside the plugins directory.`). With per-file links the plugin directory is real, so `remove` works. Each link resolves back into the clone, so `REPO_ROOT`, `hooks/engine.ts`, `bin/` and `skills/` are the clone's.
- Do not copy the files. A copy has no engine beside it: the bridge never starts Bun and logs one warning.
- `hermes plugins install <Git URL>` is not a supported route for this repository. Hermes accepts a subdirectory after `#` (tested with `file://<clone>#hosts/hermes`), but it copies that subtree into the plugin directory, which is the copy case: `hermes chat -q '/ultrathink-lessons'` then answers `Could not list lessons: [Errno 2] No such file or directory: '<HERMES_HOME>/bin/ultrathink'`.

## Verify the install

```sh
hermes plugins list --plain
hermes plugins doctor ultrathink
hermes plugins validate hosts/hermes
```

`ultrathink` should be listed as enabled. `doctor` prints `OK: runtime discovery, manifest parsing, import, and registration passed`. `validate` passes with a warning (see Known limitations).

## Reload

Enabling notifies a running gateway: slash commands and hooks apply immediately, and tools and prompt changes apply from the next session. If no gateway responded, Hermes reports that a restart is required.

## Commands

`register()` adds the `/ultrathink-<verb>` commands with `ctx.register_command`, under their bare names such as `ultrathink-lessons`. Hermes routes a typed `/ultrathink-lessons` by that name.

- In an interactive `hermes chat`, typing the command gets the reply inline.
- `hermes chat -q '/ultrathink-lessons'` gets the same reply. `-q` runs its turn through a gateway, which starts automatically when none is running and exits after 600 s with no work.
- The reply needs the plugin enabled. With the plugin disabled, Hermes answers `Unknown command /ultrathink-lessons.`

## Uninstall

```sh
hermes plugins disable ultrathink   # keep files, stop loading
hermes plugins remove ultrathink    # remove the plugin directory
ls -l ~/.hermes/plugins/ultrathink  # confirm nothing is left
```

If the directory remains (an earlier install linked the whole directory), run `rm -r ~/.hermes/plugins/ultrathink`. It deletes links only, so the repository is untouched.

## Permissions

From `hosts/hermes/plugin.yaml` and `hosts/hermes/__init__.py`:

- Hooks: `pre_llm_call` (adds planning context per prompt), `transform_tool_result`, `post_tool_call`, `pre_verify`, `subagent_start`, `post_llm_call`, `on_session_finalize`.
- Tools: `ultrathink_lesson_save`, `ultrathink_lesson_recall` (hidden unless Teachable Moments is on).
- Commands: `/ultrathink-learn`, `/ultrathink-lessons`, and control verbs. Skills: five `SKILL.md` files under `skills/`.
- The bridge starts child processes with `ULTRATHINK_HOST=hermes`.
- The manifest declares no `requires_env`, `capabilities`, `python_dependencies`, or tool override, so no `--allow-tool-override` grant is needed.

## Known limitations

- Validator warning: a private core import in `bridge.py` (`hermes_cli.plugins`, `_resolve_hook_callback_timeout`). If that call fails, the bridge uses `plugins.hook_callback_timeout` from the profile's `config.yaml`, else Hermes' 30 s default, and logs one warning.
- The validator passes after the hooks key was renamed to the documented `provides_hooks`. The old `hooks:` key failed validation.
- `requires_hermes` is not declared; no Hermes minimum is documented.
- The gateway does not load project-level `.hermes/plugins/`. Use the user location.
- A plugin directory that is itself a symlink is discovered, but `hermes plugins remove` refuses it on v0.23.1. Use per-file links.
- `hermes plugins install` copies the plugin, and the copy has no engine. See Install.

## Sources

- `.planning/research/hosts/host-contracts.md`, section "2. Hermes Agent" (CB05).
- S-HER-UG (`website/docs/user-guide/features/plugins.md`), S-HER-DEV (`website/docs/developer-guide/plugins/index.md`), in the Hermes install.
- S-HER-CLI: local `hermes plugins` `--help` output.
- S-HER-SRC: Hermes v0.23.1 source: `hermes_cli/plugins_cmd.py` (`_sanitize_plugin_name`), `hermes_cli/plugins_cmd_remove.py` (`_remove_user_plugin`), `hermes_cli/plugins_context.py` (`register_command`), `gateway/run_inbound_hooks.py` (`_hm_dispatch_plugin_command`).
- S-HER-REPO: `hosts/hermes/plugin.yaml`, `__init__.py`, `bridge.py`.
