# STATE.md and ROADMAP.md writer contract

Status: implemented in-repo (phase 112). The gsd-core writer is out of repo and is not changed by this phase.
Decision: ADR 0001, decision 5 (`docs/adr/0001-persist-and-gate-the-phase-lifecycle.md`). Requirement: LIFE-03.

## 1. Rule

One writer changes `STATE.md` and `ROADMAP.md`. Every write goes through a guarded writer. A write that finds the file changed since it was read fails. A write that finds the lock held waits up to a bounded wait (30 s by default), then fails. The writer never retries a changed file; the caller re-reads.

The reference writer is `src/workflow/guarded-write.ts`. The gsd-core writer at `/root/.agents/gsd-core` is out of repo and must adopt this same contract. This repository defines the contract; it does not implement the gsd-core side.

## 2. Operations

| Operation | Signature | Result |
|---|---|---|
| Read | `readGuarded(path)` | `{ text, hash }`. A missing file gives `{ text: "", hash: ABSENT }`. |
| Write | `writeGuarded(path, expectedHash, next)` | `{ hash }`, the hash of `next`. |
| Create | `writeGuarded(path, ABSENT, next)` | Succeeds only when the file does not exist. |

The hash is SHA-256 of the UTF-8 bytes, as lowercase hex (`hashContent`). A caller passes the hash from the read it based its edit on. It never passes a hash it computed from its own copy of the text.

## 3. Write sequence

1. Take `<path>.lock` with exclusive create (`acquireLock`) and write this process's pid into it. If the lock exists, retry every 10 to 20 ms until the wait runs out (`lockWaitMs`, default 30 000 ms), then throw `LockHeldError`. Before each retry, take over a stale lock (§5). A process that already holds the lock for this path runs the write directly (`withGuardedLock`) and neither waits nor releases the outer lock.
2. Under the lock, re-read the file and hash it. If the hash differs from `expectedHash`, throw `ConcurrentWriteError`. The file is not touched.
3. Write `next` to a temp file in the same directory, with a unique name and exclusive create. Fsync it, rename it over the path, then fsync the directory (`replaceFile`; `fsyncDirectory`).
4. Remove the lock file this call created, in a `finally` block.

## 4. Errors

| Error | Thrown when | Target file | Lock file |
|---|---|---|---|
| `ConcurrentWriteError` | Hash mismatch under the lock. Message names the path, the expected hash, and the actual hash. | Unchanged | Removed |
| `LockHeldError` | `<path>.lock` is still held when the wait runs out. Message names the lock path. | Unchanged | Left in place |
| Other I/O error | Disk full, permission denied, failed fsync. | Unchanged, unless the directory fsync fails after the rename | Removed when this call created it |

When the directory fsync fails after the rename, the target already holds the new text and the call still throws. The caller must read again before any further write.

Temp files are removed on every failure before the rename.

## 5. Stale locks

A writer takes over an existing lock in two cases:

- Dead holder: the lock body is a pid that no longer exists (`process.kill(pid, 0)` fails with `ESRCH`). A body that is not a pid is never treated as dead, because its writer may still be creating it.
- Deadman: the lock file is older than 60 seconds (`LOCK_DEADMAN_MS`), whatever its holder. A live writer that stalls longer than that can lose mutual exclusion. This is the accepted trade-off: a crashed writer must not block every later write forever.

Removal happens only while the lock body still equals the body that was judged, so a lock replaced by a live writer is not removed. A writer never removes a lock whose holder is alive and younger than 60 seconds. An operator may still remove a lock by hand after confirming that no writer is running.

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
- Lock owner identification beyond the pid. The lock body is the holder's pid and nothing else. A pid means something only on the machine that wrote it, which is why the design assumes a local filesystem (above).
- The gsd-core writer's implementation, and the milestone-complete gate (LIFE-02).

## 8. Tests

`src/workflow/guarded-write.test.ts` checks behavior on a temp directory:

- a read then a write with the same hash succeeds and leaves no lock;
- a second writer from the same base hash gets `ConcurrentWriteError`, and the file keeps the first writer's text;
- a pre-existing lock file makes the write throw and is left in place;
- a lock left by a dead holder is taken over and the write lands;
- a lock older than 60 seconds is taken over even when its holder pid is alive;
- a lock 5 seconds old with a live pid still refuses after the wait budget;
- a nested `withGuardedLock` on a path this process holds runs without waiting;
- a missing file reads as `ABSENT`; a create with `ABSENT` succeeds once, and a second create fails;
- a stale hash fails even when the new content equals the current content;
- simultaneous writers from four OS processes: one commits whole content, the rest fail with named errors, and no lock remains.
