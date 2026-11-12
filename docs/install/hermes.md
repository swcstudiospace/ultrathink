# Install ultrathink in Hermes

## Requirements

- Hermes Agent v0.23.1 (2026.9.24), observed. Minimum Hermes version: not documented.
- Python 3.10 or later, per the comment in `hosts/hermes/plugin.yaml`.
- A complete checkout. `hosts/hermes/bridge.py` resolves `REPO_ROOT` from its own path and loads skills from `skills/`.

## Install

The manifest lives in `hosts/hermes/`, not the repository root. From the repository root:

```sh
mkdir -p ~/.hermes/plugins
ln -s "$PWD/hosts/hermes" ~/.hermes/plugins/ultrathink
hermes plugins enable ultrathink
```

- `~/.hermes/plugins/` is a documented user plugin location. Hermes documents no symlink behavior for it; confirm the link in "Verify the install".
- Do not copy `hosts/hermes/` instead. A copy breaks `REPO_ROOT` and the skill paths.
- `hermes plugins install <Git URL | owner/repo>` is the other documented route. It is not confirmed for this repository: the CLI has no subdirectory option and the root has no `plugin.yaml`.

## Verify the install

```sh
hermes plugins list --plain
hermes plugins validate hosts/hermes
```

`ultrathink` should be listed as enabled. `validate` passes with a warning (see Known limitations).

## Reload

Enabling notifies a running gateway: slash commands and hooks apply immediately, and tools and prompt changes apply from the next session. If no gateway responded, Hermes reports that a restart is required.

## Uninstall

```sh
hermes plugins disable ultrathink   # keep files, stop loading
hermes plugins remove ultrathink    # remove the plugin
ls -l ~/.hermes/plugins/ultrathink  # confirm nothing is left
```

If the link remains, run `rm ~/.hermes/plugins/ultrathink`. This does not touch the repository. Hermes keeps plugin data directories on remove.

## Permissions

From `hosts/hermes/plugin.yaml` and `hosts/hermes/__init__.py`:

- Hooks: `pre_llm_call` (adds planning context per prompt), `transform_tool_result`, `post_tool_call`, `pre_verify`, `subagent_start`, `post_llm_call`, `on_session_finalize`.
- Tools: `ultrathink_lesson_save`, `ultrathink_lesson_recall` (hidden unless Teachable Moments is on).
- Commands: `/ultrathink-learn`, `/ultrathink-lessons`, and control verbs. Skills: five `SKILL.md` files under `skills/`.
- The bridge starts child processes with `ULTRATHINK_HOST=hermes`.
- The manifest declares no `requires_env`, `capabilities`, `python_dependencies`, or tool override, so no `--allow-tool-override` grant is needed.

## Known limitations

- Validator warning: a private core import at `bridge.py:153` (`hermes_cli.plugins`, `_resolve_hook_callback_timeout`). If that call fails, the bridge uses `plugins.hook_callback_timeout` from the profile's `config.yaml`, else Hermes' 30 s default, and logs one warning.
- The validator passes after the hooks key was renamed to the documented `provides_hooks`. The old `hooks:` key failed validation.
- `requires_hermes` is not declared; no Hermes minimum is documented.
- The gateway does not load project-level `.hermes/plugins/`. Use the user location.
- Symlink discovery and Git-URL install for this repository are not confirmed by Hermes documentation.

## Sources

- `.planning/research/hosts/host-contracts.md`, section "2. Hermes Agent" (CB05).
- S-HER-UG (`website/docs/user-guide/features/plugins.md`), S-HER-DEV (`website/docs/developer-guide/plugins/index.md`), in the Hermes install.
- S-HER-CLI: local `hermes plugins` `--help` output.
- S-HER-REPO: `hosts/hermes/plugin.yaml`, `__init__.py`, `bridge.py`.
