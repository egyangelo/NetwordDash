"""Persistent settings, stored per-user with owner-only permissions."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "dns_profile": "familyshield",
    "router": {
        "host": "",
        "username": "admin",
        "password": "",
        "remember": True,
    },
    "scan": {
        "ping_timeout_ms": 900,
        "autorefresh_seconds": 45,
    },
    # Custom device names keyed by normalized MAC address.
    "labels": {},
    # Manual device-type overrides keyed by normalized MAC address.
    "types": {},
}


def config_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "NetDash"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "netdash"


def config_path() -> Path:
    return config_dir() / "config.json"


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load() -> dict[str, Any]:
    path = config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return json.loads(json.dumps(DEFAULTS))
        return _merge(DEFAULTS, data)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return json.loads(json.dumps(DEFAULTS))


def save(data: dict[str, Any]) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2).encode("utf-8")
    # The file holds the router password, so it must be owner-only from the
    # first byte: mkstemp creates it 0600, unlike write_text() (0644 under the
    # default umask) followed by a chmod.
    fd, tmp_name = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def get_router_credentials() -> tuple[str, str, str]:
    cfg = load()
    router = cfg.get("router") or {}
    return (
        str(router.get("host") or "").strip(),
        str(router.get("username") or "").strip(),
        str(router.get("password") or ""),
    )
