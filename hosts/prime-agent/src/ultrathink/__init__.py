# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Prime Agent host for ultrathink.

Prime Agent has no prompt hook: the agent's persistent Python kernel loads this package as the
``ultrathink`` skill and calls it. Planning still runs in the shared TypeScript engine
(``hooks/engine.ts``) through ``bin/run-bun``: one JSON request on stdin, one ``PlanResponse``
line on stdout, always exit 0. This module only spawns the engine, carries the result back
into the kernel and reads the files the engine wrote. It never plans by itself, never imports
Prime Agent and never raises on an engine failure (fail-open: the agent gets ``planned=False``
and a reason, the user's request still stands).

Request/response contract: ``hooks/engine.ts`` and ``src/host/plan.ts`` (``PlanRequest`` /
``PlanResponse``). State directory: ``src/host/paths.ts`` (``prime-agent`` branch).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

HOST = "prime-agent"
__all__ = [
	"HOST",
	"run",
	"plan",
	"ctl",
	"status",
	"last",
	"spec",
	"teach",
	"state_dir",
	"repo_root",
	"session_id",
]

_THIS = Path(__file__).resolve()
# hosts/prime-agent/src/ultrathink/__init__.py -> the clone (the skill directory is a symlink into it, or a copy of hosts/prime-agent).
_HOST_DIR = _THIS.parents[2]
_LAYOUT_ROOT = _THIS.parents[4] if len(_THIS.parents) > 4 else _HOST_DIR
_DEFAULT_CLONE = Path.home() / "src" / "repos" / "claude-ultrathink"
ENGINE_REL = Path("hooks") / "engine.ts"
RUN_BUN_REL = Path("bin") / "run-bun"
CLI_REL = Path("bin") / "ultrathink"
TEACH_REL = Path("src") / "teach" / "cli.ts"

CONTROL_TIMEOUT_S = 30.0
TEACH_TIMEOUT_S = 120.0
# How long a cancelled plan waits after SIGTERM before SIGKILL. Not a plan deadline.
TERM_GRACE_S = 3.0




def _env(extra: dict[str, str] | None = None) -> dict[str, str]:
	merged = {**os.environ, **(extra or {})}
	merged["ULTRATHINK_HOST"] = HOST
	# The kernel is never an engine child; a leaked marker from another host's shell must not silence planning.
	merged.pop("ULTRATHINK_CHILD", None)
	return merged


def repo_root(env: dict[str, str] | None = None) -> Path:
	"""The claude-ultrathink clone the engine runs from: ``ULTRATHINK_PLUGIN_ROOT``, else the clone this file
	lives in (``hosts/prime-agent`` symlinked into ``~/.prime/agent/skills/ultrathink``), else ``~/src/repos/claude-ultrathink``."""
	merged = _env(env)
	override = merged.get("ULTRATHINK_PLUGIN_ROOT", "").strip()
	if override:
		return Path(override).expanduser()
	for candidate in (_LAYOUT_ROOT, _DEFAULT_CLONE):
		if (candidate / ENGINE_REL).is_file():
			return candidate
	return _LAYOUT_ROOT


def _is_planning_path(path: str) -> bool:
	norm = path.replace("\\", "/").rstrip("/")
	return norm == ".planning" or norm.endswith("/.planning") or "/.planning/" in norm


def state_dir(env: dict[str, str] | None = None) -> Path:
	"""Where the engine keeps control, sessions, specs and ``last-plan.<session>.json`` for Prime Agent, located the way
	``src/host/paths.ts`` does: ``ULTRATHINK_STATE_DIR`` unless it points into a ``.planning`` tree, else
	``${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink``."""
	merged = _env(env)
	override = merged.get("ULTRATHINK_STATE_DIR", "").strip()
	if override and not _is_planning_path(override):
		return Path(override).expanduser()
	home = merged.get("PRIME_AGENT_CODING_AGENT_DIR", "").strip() or str(Path.home() / ".prime" / "agent")
	return Path(home).expanduser() / "ultrathink"


def session_id(env: dict[str, str] | None = None) -> str:
	"""The Prime Agent session id (the ``RLM_SESSION_DIR`` leaf), ``ULTRATHINK_SESSION_ID`` when set, else ``unknown``.
	The engine names its session record and spec after it, so a session re-plans into its own files."""
	merged = _env(env)
	explicit = merged.get("ULTRATHINK_SESSION_ID", "").strip()
	if explicit:
		return explicit
	session = merged.get("RLM_SESSION_DIR", "").strip()
	if session:
		leaf = Path(session).name.strip()
		if leaf:
			return leaf
	return "unknown"


def _engine_command(root: Path, env: dict[str, str]) -> list[str] | None:
	engine = root / ENGINE_REL
	if not engine.is_file():
		return None
	bun = env.get("BUN", "").strip()
	if bun:
		return [bun, "--no-env-file", str(engine)]
	runner = root / RUN_BUN_REL
	if not runner.is_file():
		return None
	return [str(runner), str(engine)]


def _read_text(path: str | None) -> str | None:
	if not path:
		return None
	try:
		return Path(path).read_text(encoding="utf-8", errors="replace")
	except OSError:
		return None


def _skip(reason: str, **extra: Any) -> dict[str, Any]:
	return {"planned": False, "skipped": reason, "context": "", **extra}

def _signal_group(proc: subprocess.Popen[str], sig: int) -> None:
	try:
		os.killpg(proc.pid, sig)
	except (ProcessLookupError, PermissionError):
		pass


def _stop_engine(proc: subprocess.Popen[str]) -> None:
	"""SIGTERM the engine process group, then SIGKILL after ``TERM_GRACE_S`` if it is still alive.

	Does not ``wait`` or close the pipes: ``plan``'s ``communicate`` owns that wait. SIGTERM first so the
	engine can stop model CLIs it started in their own sessions; SIGKILL then sweeps this group.
	"""
	_signal_group(proc, signal.SIGTERM)
	deadline = time.monotonic() + TERM_GRACE_S
	while time.monotonic() < deadline:
		if proc.poll() is not None:
			return
		time.sleep(0.05)
	if proc.poll() is None:
		_signal_group(proc, signal.SIGKILL)


class _EngineHandle:
	"""The engine ``Popen``, published before ``communicate`` so ``run`` can stop it on cancel."""

	def __init__(self) -> None:
		self._lock = threading.Lock()
		self.proc: subprocess.Popen[str] | None = None
		self.cancelled = False

	def __call__(self, proc: subprocess.Popen[str]) -> bool:
		"""Record ``proc``. True when the run is already cancelled, so ``plan`` must not communicate."""
		with self._lock:
			self.proc = proc
			return self.cancelled

	def stop(self) -> None:
		"""Mark the run cancelled and SIGTERM/SIGKILL the group when the process is already published."""
		with self._lock:
			self.cancelled = True
			proc = self.proc
		if proc is not None:
			_stop_engine(proc)


def plan(
	text: str,
	*,
	cwd: str | None = None,
	session: str | None = None,
	force: bool = False,
	raw: bool = False,
	env: dict[str, str] | None = None,
	on_process: Callable[[subprocess.Popen[str]], bool] | None = None,
) -> dict[str, Any]:
	"""Plan one request through the engine (synchronous; ``run`` is the awaitable wrapper).

	Returns a dict: ``planned`` (bool), ``context`` (the plan text the agent works from), ``skipped`` (reason when
	not planned), ``summary``, ``spec_path`` / ``spec`` (the XML), ``state_path``, ``graph_id``, ``carrier_path``,
	``view``, ``model_resolution``, ``elapsed_s``. Never raises.
	"""
	prompt = (text or "").strip()
	if not prompt:
		return _skip("empty")
	if raw and not prompt.lower().startswith("raw:"):
		prompt = f"raw: {prompt}"
	elif force and not prompt.lower().startswith("uplift:"):
		prompt = f"uplift: {prompt}"
	child_env = _env(env)
	root = repo_root(env)
	command = _engine_command(root, child_env)
	if command is None:
		return _skip(
			"engine-missing",
			error=f"{root / ENGINE_REL} or {root / RUN_BUN_REL} not found; set ULTRATHINK_PLUGIN_ROOT to a full clone of claude-ultrathink",
		)
	workdir = (cwd or "").strip() or os.getcwd()
	request = {
		"host": HOST,
		"session_id": (session or "").strip() or session_id(env),
		"prompt": prompt,
		"cwd": workdir,
		"platform": "prime-agent",
	}
	started = time.monotonic()
	try:
		# Bun leads its own process group. There is no product deadline; plan() waits until the engine exits.
		# on_process is invoked before communicate so a cancelled run() can signal this group.
		proc = subprocess.Popen(
			command,
			stdin=subprocess.PIPE,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			text=True,
			encoding="utf-8",
			errors="replace",
			env=child_env,
			cwd=str(root),
			start_new_session=True,
		)
	except OSError as error:
		return _skip("engine-spawn-failed", error=str(error))
	if on_process is not None and on_process(proc):
		_stop_engine(proc)
		return _skip("cancelled")
	stdout, stderr = proc.communicate(input=json.dumps(request), timeout=None)
	if on_process is not None and getattr(on_process, "cancelled", False):
		return _skip("cancelled")
	elapsed = round(time.monotonic() - started, 1)
	# bin/run-bun exits 0 with no output when bun is missing (fail-open); the hint is on stderr.
	line = next((entry for entry in reversed((stdout or "").splitlines()) if entry.strip().startswith("{")), "")
	try:
		parsed = json.loads(line) if line else {}
	except json.JSONDecodeError:
		parsed = {}
	if not isinstance(parsed, dict) or not parsed:
		detail = " ".join((stderr or "").split())[:300]
		return _skip("engine-no-output", error=detail or f"exit code {proc.returncode}", elapsed_s=elapsed)
	context = parsed.get("context") if isinstance(parsed.get("context"), str) else ""
	result: dict[str, Any] = {
		"planned": bool(context),
		"context": context,
		"skipped": parsed.get("skipped"),
		"summary": parsed.get("summary"),
		"spec_path": parsed.get("specPath"),
		"state_path": parsed.get("statePath"),
		"graph_id": parsed.get("graphId"),
		"carrier_path": parsed.get("carrierPath"),
		"view": parsed.get("view"),
		"model_resolution": parsed.get("modelResolution"),
		"elapsed_s": elapsed,
	}
	result["spec"] = _read_text(result["spec_path"]) if context else None
	return result


async def run(
	text: str,
	*,
	cwd: str | None = None,
	session: str | None = None,
	force: bool = False,
	raw: bool = False,
) -> dict[str, Any]:
	"""Plan a request with ultrathink: Prompt Uplift (XML spec), Graph of Thought with WORKFLOW waves, HITL
	questions and, when configured, Linear/Notion rows.

	Args:
		text: the user's request, verbatim. ``/skill:<name> <task>`` is planned as that skill's task.
		cwd: project directory (config layers and skill lookup); defaults to the kernel's cwd.
		session: session id for the state files; defaults to the Prime Agent session id.
		force: prefix ``uplift:`` so planning-off and trivial-prompt gates do not skip.
		raw: prefix ``raw:`` so nothing is planned (returns ``planned=False``).

	Returns the ``plan()`` dict. Work from ``context``; it names the spec file, the HITL questions and, with tracking
	on, tells you to run the ``ultrathink-kickoff`` skill first. Re-raises ``asyncio.CancelledError`` after SIGTERM
	and, following ``TERM_GRACE_S``, SIGKILL of the engine process group — a cancelled run is not a finished plan.
	"""
	import asyncio

	handle = _EngineHandle()
	try:
		result = await asyncio.to_thread(plan, text, cwd=cwd, session=session, force=force, raw=raw, on_process=handle)
	except asyncio.CancelledError:
		# Own thread, not the plan pool and not the event loop: cleanup must not wait for a busy communicate.
		threading.Thread(target=handle.stop, daemon=True).start()
		raise
	if handle.cancelled or result.get("skipped") == "cancelled":
		raise asyncio.CancelledError
	return result


def _run_cli(root: Path, argv: list[str], timeout: float, env: dict[str, str] | None, stdin: str | None = None) -> tuple[bool, str]:
	try:
		completed = subprocess.run(
			argv,
			input=stdin,
			encoding="utf-8",
			errors="replace",
			capture_output=True,
			timeout=timeout,
			env=_env(env),
			cwd=str(root),
			check=False,
		)
	except subprocess.TimeoutExpired:
		return False, f"no answer after {timeout:g}s"
	except OSError as error:
		return False, " ".join(str(error).split())
	text = completed.stdout.strip()
	if completed.returncode == 0:
		return True, text
	lines = [line.strip() for line in f"{completed.stderr}\n{text}".splitlines() if line.strip()]
	detail = next((line for line in lines if line.startswith("error:")), lines[0] if lines else "")
	return False, detail or f"exit code {completed.returncode}"


# The control verbs whose answer belongs to one session: `skip` arms this session's next prompt, `status` shows whether it is armed.
SESSION_CONTROL_VERBS = ("skip", "status")


def control_args(args: tuple[str, ...] | list[str], session: str | None) -> list[str]:
	"""The bin/ultrathink argv for a control. A session-scoped verb gets ``--session <id>``; a blank id gets none, so the
	CLI refuses ``skip`` rather than arming it for every session."""
	argv = list(args)
	sid = (session or "").strip()
	if sid and argv and argv[0] in SESSION_CONTROL_VERBS:
		argv += ["--session", sid]
	return argv


def _kernel_session(env: dict[str, str] | None = None) -> str | None:
	"""This kernel's session id, or None when it has none (``session_id`` then answers its ``unknown`` placeholder)."""
	sid = session_id(env)
	return None if sid == "unknown" else sid


def ctl(*args: str, env: dict[str, str] | None = None, session: str | None = None) -> str:
	"""Planner controls against the Prime Agent state directory, the ``/ultrathink-*`` commands of the other hosts:
	``ctl("status")``, ``ctl("off")``, ``ctl("on")``, ``ctl("skip")``, ``ctl("track", "off"|"on"|"status")``,
	``ctl("think", "on"|"off"|"last"|"status")``, ``ctl("hitl", ...)``, ``ctl("grok", "engine", "auto"|"claude"|"grok"|"muse")``,
	``ctl("last")``. ``session`` names the session a skip or status is for; by default it is this kernel's session, when it has one.
	Returns the CLI's text, or one line saying what failed."""
	root = repo_root(env)
	cli = root / CLI_REL
	if not cli.is_file():
		return f"Ultrathink: {cli} not found; set ULTRATHINK_PLUGIN_ROOT to a full clone of claude-ultrathink"
	ok, text = _run_cli(root, [str(cli), *control_args(args, session or _kernel_session(env))], CONTROL_TIMEOUT_S, env)
	return text if ok else f"Ultrathink {' '.join(args[:1]) or 'status'} failed: {text}"


def status(env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Where things are and what the planner would do: clone, engine presence, state dir, session id, and the
	``ultrathink status`` text (planning on/off, tracking, engine route)."""
	root = repo_root(env)
	return {
		"host": HOST,
		"repo_root": str(root),
		"engine": str(root / ENGINE_REL),
		"engine_present": (root / ENGINE_REL).is_file(),
		"state_dir": str(state_dir(env)),
		"session_id": session_id(env),
		"control": ctl("status", env=env),
	}


def carrier_name(session: str) -> str:
	"""The carrier file name of a session, spelled as ``src/host/carrier.ts`` does: every character outside
	``[A-Za-z0-9_-]`` becomes ``_`` (one per UTF-16 unit, as JavaScript counts), at most 64 of them."""
	safe = "".join(
		ch if ch.isascii() and (ch.isalnum() or ch in "_-") else "_" * (2 if ord(ch) > 0xFFFF else 1) for ch in session
	)[:64]
	return f"last-plan.{safe or '_'}.json"


def _read_carrier(path: Path) -> dict[str, Any] | None:
	try:
		parsed = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError):
		return None
	return parsed if isinstance(parsed, dict) else None


def last(env: dict[str, str] | None = None, session_id: str | None = None) -> dict[str, Any] | None:
	"""The carrier of a session's last planned prompt (``last-plan.<session>.json``: session, spec path, graph id,
	context), or None. A named ``session_id`` reads that session's file only, and a file that names another session is
	never returned. Without one, this kernel's session is read first; failing that, the single-file carrier of an
	earlier build is returned only while no session has a carrier of its own, and, for a known session, only when it names
	that session, so one state directory shared by several sessions never hands out another session's plan."""
	directory = state_dir(env)
	session = session_id or _kernel_session(env)
	if session:
		carrier = _read_carrier(directory / carrier_name(session))
		if carrier is not None and carrier.get("sessionId") == session:
			return carrier
		if session_id:
			return None
	try:
		if any(directory.glob("last-plan.*.json")):
			return None
	except OSError:
		return None
	legacy = _read_carrier(directory / "last-plan.json")
	# With a known session the earlier build's single file is that session's plan only when it says so.
	if session and legacy is not None and legacy.get("sessionId") != session:
		return None
	return legacy


def spec(env: dict[str, str] | None = None, session_id: str | None = None) -> str | None:
	"""The XML spec of this session's last planned prompt, or None."""
	carrier = last(env, session_id)
	return _read_text(carrier.get("specPath")) if carrier else None


def teach(*args: str, stdin: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Teachable Moments (``src/teach/cli.ts``) for this host: ``teach("status")``, ``teach("recall", "<query>")``,
	``teach("capture", "--stdin", stdin=json)``, ``teach("promote", "--due")``, ``teach("promote", "<id>", "--target", "prime-agent", "--install")``.
	``--json`` is added when absent; returns the parsed JSON, or ``{"error": ...}``."""
	root = repo_root(env)
	entry = root / TEACH_REL
	runner = root / RUN_BUN_REL
	if not entry.is_file() or not runner.is_file():
		return {"error": f"{entry} or {runner} not found"}
	argv = [str(runner), str(entry), *args]
	if "--json" not in args:
		argv.append("--json")
	ok, text = _run_cli(root, argv, TEACH_TIMEOUT_S, env, stdin=stdin)
	if not ok:
		return {"error": text}
	try:
		parsed = json.loads(text) if text else {}
	except json.JSONDecodeError:
		return {"error": "teach CLI did not answer JSON", "text": text[:500]}
	return parsed if isinstance(parsed, dict) else {"result": parsed}
