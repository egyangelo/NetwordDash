"""Persistent settings, stored per-user with owner-only permissions."""

from __future__ import annotations

import json
import os
import stat
import sys
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
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except OSError:
        pass
    os.replace(tmp, path)


def get_router_credentials() -> tuple[str, str, str]:
    cfg = load()
    router = cfg.get("router") or {}
    return (
        str(router.get("host") or "").strip(),
        str(router.get("username") or "").strip(),
        str(router.get("password") or ""),
    )
