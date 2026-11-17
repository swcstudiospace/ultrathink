# STATE.md and ROADMAP.md writer contract

Status: implemented in-repo (phase 112). The gsd-core writer is out of repo and is not changed by this phase.
Decision: ADR 0001, decision 5 (`docs/adr/0001-persist-and-gate-the-phase-lifecycle.md`). Requirement: LIFE-03.

## 1. Rule

One writer changes `STATE.md` and `ROADMAP.md`. Every write goes through a guarded writer. A write that finds the file changed since it was read fails. A write that finds a lock held fails. Neither is retried silently.

The reference writer is `src/workflow/guarded-write.ts`. The gsd-core writer at `/root/.agents/gsd-core` is out of repo and must adopt this same contract. This repository defines the contract; it does not implement the gsd-core side.

## 2. Operations

| Operation | Signature | Result |
|---|---|---|
| Read | `readGuarded(path)` | `{ text, hash }`. A missing file gives `{ text: "", hash: ABSENT }`. |
| Write | `writeGuarded(path, expectedHash, next)` | `{ hash }`, the hash of `next`. |
| Create | `writeGuarded(path, ABSENT, next)` | Succeeds only when the file does not exist. |

The hash is SHA-256 of the UTF-8 bytes, as lowercase hex (`hashContent`). A caller passes the hash from the read it based its edit on. It never passes a hash it computed from its own copy of the text.

## 3. Write sequence

1. Create `<path>.lock` with exclusive create (`acquireLock`). If the file exists, throw `LockHeldError`.
2. Under the lock, re-read the file and hash it. If the hash differs from `expectedHash`, throw `ConcurrentWriteError`. The file is not touched.
3. Write `next` to a temp file in the same directory, with a unique name and exclusive create. Fsync it, rename it over the path, then fsync the directory (`replaceFile`; `fsyncDirectory`).
4. Remove the lock file this call created, in a `finally` block.

## 4. Errors

| Error | Thrown when | Target file | Lock file |
|---|---|---|---|
| `ConcurrentWriteError` | Hash mismatch under the lock. Message names the path, the expected hash, and the actual hash. | Unchanged | Removed |
| `LockHeldError` | `<path>.lock` already exists. Message names the lock path. | Unchanged | Left in place |
| Other I/O error | Disk full, permission denied, failed fsync. | Unchanged, unless the directory fsync fails after the rename | Removed when this call created it |

When the directory fsync fails after the rename, the target already holds the new text and the call still throws. The caller must read again before any further write.

Temp files are removed on every failure before the rename.

## 5. Stale locks

A lock left by a crash stays in place. Every write then throws `LockHeldError` until the lock is removed.

Only an operator removes a stale lock, by hand, after confirming that no writer is running. No timer, lease expiry, or retry loop removes a lock. A writer never removes a lock it did not create.

## 6. Caller rules

- Do not write `STATE.md` or `ROADMAP.md` with any other tool or editor path. Writes that record a phase transition (`docs/architecture/phase-lifecycle.md`, P5) use this writer.
- On `ConcurrentWriteError`, re-read, re-derive the edit from the new text, and write again with the new hash. Do not overwrite.
- On `LockHeldError`, stop and report the lock path. Do not delete the lock.

## 7. Not covered

- Reconciling divergent worktrees, backups, or copies of the two files.
- Other planning files (`PLAN.md`, `REQUIREMENTS.md`, phase directories).
- Locking across machines or network filesystems. The design assumes a local POSIX filesystem with exclusive create and atomic rename.
- Atomicity across both files. A transition that touches `STATE.md` and `ROADMAP.md` is two guarded writes, and a failure between them is not rolled back.
- Permissions and ownership. The rename replaces the file, so its mode is the default for a new file, not the mode of the old one.
- Lock owner identification. The lock file holds no pid or timestamp.
- The gsd-core writer's implementation, and the milestone-complete gate (LIFE-02).

## 8. Tests

`src/workflow/guarded-write.test.ts` checks behavior on a temp directory:

- a read then a write with the same hash succeeds and leaves no lock;
- a second writer from the same base hash gets `ConcurrentWriteError`, and the file keeps the first writer's text;
- a pre-existing lock gives `LockHeldError`, leaves the file unchanged, and keeps the lock;
- a missing file reads as `ABSENT`; a create with `ABSENT` succeeds once, and a second create fails;
- a stale hash fails even when the new content equals the current content.
