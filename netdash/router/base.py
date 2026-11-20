"""Router adapter interface.

Per-device control has to talk to the gateway. There is no way for a normal
client PC to cut another device's traffic without the router's cooperation,
so every capability is negotiated with the adapter instead of assumed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class RouterError(Exception):
    """A router operation failed (bad credentials, timeout, unsupported...)."""


class Unsupported(RouterError):
    """The router firmware does not expose this capability."""


@dataclass
class Capabilities:
    devices: bool = False
    block: bool = False
    block_scope: str = ""          # "network" (whole LAN) or "internet"
    wifi: bool = False
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "devices": self.devices,
            "block": self.block,
            "block_scope": self.block_scope,
            "wifi": self.wifi,
            "notes": list(self.notes),
        }


class RouterAdapter:
    name = "router"

    def __init__(self, host: str):
        self.host = host
        self.connected = False
        self.model = ""
        self.caps = Capabilities()

    # -- lifecycle ---------------------------------------------------------
    def login(self, username: str, password: str) -> dict[str, Any]:
        raise NotImplementedError

    def logout(self) -> None:
        self.connected = False

    # -- reads -------------------------------------------------------------
    def devices(self) -> list[dict[str, Any]]:
        raise Unsupported(f"{self.name} does not expose a device list")

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "host": self.host,
            "model": self.model,
            "connected": self.connected,
            "capabilities": self.caps.as_dict(),
        }

    # -- writes ------------------------------------------------------------
    def set_access(self, mac: str, scope: str, allowed: bool) -> dict[str, Any]:
        raise Unsupported(f"{self.name} does not expose per-device access control")
