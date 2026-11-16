# Omp adapter: injection ports

This directory holds the Omp host's real implementations of the core injection ports. Core code depends only on the port interfaces in `core/src/ports/injection.ts`, so it can be tested with fakes and never touches the environment directly.

## What it provides

| Factory | Port | Implementation |
| --- | --- | --- |
| `createOmpFileSystem(root)` | `FileSystemPort` | `node:fs/promises` |
| `createOmpClock()` | `ClockPort` | `Date.now()` |
| `createOmpProcess(allowlist)` | `ProcessPort` | `node:child_process` `execFile` |

### FileSystemPort

- `read(path)` reads a UTF-8 file.
- `atomicWrite(path, content)` writes a temp file (`.<name>.<uuid>.tmp`) in the same directory, then renames it over the target. The temp file is removed if the write fails. Missing parent directories are created.
- `list(path)` returns the sorted names of immediate children.
- `stat(path)` returns `{ size, mtimeMs, isDirectory }`.

Relative paths resolve against `root`. Any path whose resolved form lies outside `root` is rejected with a `permission_denied` error whose message contains `outside root`. Confinement is lexical: symlinks inside `root` are followed by the OS, not re-checked.

### ProcessPort

`spawn({ command, args, cwd })` runs `command` through `execFile` with `args` as an argv array. Shell interpolation never happens. A command runs only if it is a bare name that exactly matches an allowlist entry. Path-qualified commands such as `/tmp/x/git` are rejected even when their basename is allowlisted. A non-zero exit resolves with `exitCode` set; a spawn failure rejects.

### ClockPort

`now()` returns `Date.now()`.

## Errors

Every rejection is a `CategorizedError` (`core/src/ports/command.ts`). Node error codes map as follows: `ENOENT`/`ENOTDIR` to `invalid_input`, `EACCES`/`EPERM` to `permission_denied`, anything else to `internal`. Messages carry the operation, the path or command, and the error code. They never include file contents.

## Import rule

Adapter code in `adapters/` may import Node APIs. Core code under `core/` must never import `node:*` modules, `child_process`, or `Date.now` directly. It receives these capabilities through the ports above.
