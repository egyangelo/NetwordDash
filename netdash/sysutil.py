"""Small OS helpers shared by the rest of the app."""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
from dataclasses import dataclass

IS_WINDOWS = os.name == "nt"


@dataclass
class CmdResult:
    ok: bool
    out: str
    err: str
    code: int


def run(cmd: list[str] | str, timeout: float = 8.0) -> CmdResult:
    """Run a command and never raise for a non-zero exit status."""
    if isinstance(cmd, str):
        shell = True
    else:
        shell = False
    kwargs: dict = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        p = subprocess.run(
            cmd,
            shell=shell,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            **kwargs,
        )
        return CmdResult(p.returncode == 0, p.stdout or "", p.stderr or "", p.returncode)
    except FileNotFoundError:
        return CmdResult(False, "", "command not found", 127)
    except subprocess.TimeoutExpired:
        return CmdResult(False, "", "timed out", 124)
    except OSError as exc:
        return CmdResult(False, "", str(exc), 1)


def have(name: str) -> bool:
    return shutil.which(name) is not None


def is_admin() -> bool:
    """True when the process can change system network settings."""
    if IS_WINDOWS:
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
        except Exception:
            return False
    try:
        return os.geteuid() == 0
    except AttributeError:
        return False


def json_safe(value):
    """Recursively convert sets/tuples and coerce odd types for the API."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
