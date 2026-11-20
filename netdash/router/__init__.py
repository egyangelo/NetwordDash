"""Router adapter registry and the single shared instance."""

from __future__ import annotations

import threading
import time
from typing import Any

from .base import Capabilities, RouterAdapter, RouterError, Unsupported
from .zte import ZteRouter

__all__ = ["RouterManager", "RouterAdapter", "RouterError", "Unsupported", "Capabilities"]


class RouterManager:
    """Keeps one authenticated router session for the life of the process."""

    def __init__(self):
        self._lock = threading.Lock()
        self._adapter: RouterAdapter | None = None
        self._last_probe = 0.0

    def reprobe_async(self) -> None:
        """Re-read capabilities in the background, at most every 15 seconds."""
        with self._lock:
            adapter = self._adapter
        if adapter is None or not adapter.connected:
            return
        now = time.time()
        if now - self._last_probe < 15:
            return
        self._last_probe = now

        def worker() -> None:
            try:
                adapter._probe()  # type: ignore[attr-defined]
            except Exception:
                pass

        threading.Thread(target=worker, name="router-reprobe", daemon=True).start()

    def adapter(self) -> RouterAdapter | None:
        with self._lock:
            return self._adapter

    def status(self) -> dict[str, Any]:
        with self._lock:
            adapter = self._adapter
        if adapter is None:
            return {"connected": False, "name": "", "host": "", "model": "", "capabilities": Capabilities().as_dict()}
        return adapter.status()

    def connect(self, host: str, username: str, password: str) -> dict[str, Any]:
        host = (host or "").strip()
        if not host:
            raise RouterError("Router address is required.")
        adapter = ZteRouter(host)
        info = adapter.login(username, password)
        with self._lock:
            self._adapter = adapter
        return info

    def selftest(self) -> dict[str, Any]:
        with self._lock:
            adapter = self._adapter
        if adapter is None:
            raise RouterError("Connect the router first.")
        if not hasattr(adapter, "selftest"):
            raise RouterError("This router adapter has no self-test.")
        return adapter.selftest()

    def diagnostics(self) -> dict[str, Any]:
        with self._lock:
            adapter = self._adapter
        if adapter is None:
            raise RouterError("Connect the router first.")
        if not hasattr(adapter, "diagnostics"):
            raise RouterError("Diagnostics are not available for this router.")
        return adapter.diagnostics()

    def disconnect(self) -> None:
        with self._lock:
            adapter, self._adapter = self._adapter, None
        if adapter is not None:
            adapter.logout()
