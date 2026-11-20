"""Application state and the JSON API used by the browser UI."""

from __future__ import annotations

import re
import threading
import time
from typing import Any

from . import __version__, config
from .dnsman import DnsManager
from .netinfo import NetworkInfo, default_gateway
from .router import RouterError, RouterManager, Unsupported
from .scanner import DeviceScanner, device_type, vendor_for
from .speedtest import SpeedTest
from .sysutil import is_admin


def _normalize_mac(value: str) -> str:
    raw = re.sub(r"[^0-9a-fA-F]", "", value)
    if len(raw) != 12:
        return ""
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2)).lower()


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.hint = hint


class App:
    def __init__(self):
        self.cfg = config.load()
        self.netinfo = NetworkInfo()
        self.scanner = DeviceScanner(
            ping_timeout_ms=int((self.cfg.get("scan") or {}).get("ping_timeout_ms", 900))
        )
        self.dns = DnsManager(self.netinfo)
        self.router = RouterManager()
        self.speedtest = SpeedTest()
        self._scan_lock = threading.Lock()
        self._scan_error = ""
        self._last_scan = 0.0
        self._auto_router_tried = False
        self._ensure_router()

    # -- helpers -----------------------------------------------------------
    def _snapshot(self, force: bool = False) -> dict[str, Any]:
        return self.netinfo.snapshot(force=force)

    def _ensure_router(self) -> None:
        """Try the saved router credentials once, in the background."""
        if self._auto_router_tried:
            return
        self._auto_router_tried = True
        host, username, password = config.get_router_credentials()
        if not password:
            return

        def worker() -> None:
            try:
                self.router.connect(host or default_gateway(), username, password)
            except Exception:
                pass

        threading.Thread(target=worker, name="router-autologin", daemon=True).start()

    def _merge_router_devices(self, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
        adapter = self.router.adapter()
        if adapter is None or not adapter.caps.devices:
            return devices
        try:
            remote = adapter.devices()
        except Exception:
            return devices

        by_mac = {d["mac"]: d for d in devices if d.get("mac")}
        merged = list(devices)
        for item in remote:
            mac = item.get("mac")
            if not mac:
                continue
            existing = by_mac.get(mac)
            if existing:
                if not existing.get("name") and item.get("name"):
                    existing["name"] = item["name"]
                existing["source"] = "lan+router"
                existing["connection"] = item.get("connection", existing.get("connection", ""))
                existing["blocked"] = bool(item.get("blocked"))
                existing["wifi_blocked"] = bool(item.get("wifi_blocked"))
                if item.get("ssid"):
                    existing["ssid"] = item["ssid"]
            else:
                merged.append(
                    {
                        "ip": item.get("ip", ""),
                        "mac": mac,
                        "name": item.get("name", ""),
                        "vendor": vendor_for(mac),
                        "type": device_type(vendor_for(mac), mac),
                        "online": True,
                        "responded": None,
                        "state": "router",
                        "is_self": False,
                        "is_gateway": False,
                        "random_mac": False,
                        "ssid": item.get("ssid", ""),
                        "connection": item.get("connection", ""),
                        "blocked": bool(item.get("blocked")),
                        "wifi_blocked": bool(item.get("wifi_blocked")),
                        "source": "router",
                        "last_seen": int(time.time()),
                    }
                )
        return merged

    # -- API ---------------------------------------------------------------
    def state(self) -> dict[str, Any]:
        snap = self._snapshot()
        dns_state = self.dns.state(snap.get("interface", ""))
        router_state = self.router.status()
        if router_state.get("connected") and not router_state.get("capabilities", {}).get("block"):
            # A probe can fail while the router settles (or another admin
            # session is active). Retry quietly in the background.
            self.router.reprobe_async()
        return {
            "version": __version__,
            "platform": snap.get("platform", ""),
            "hostname": snap.get("hostname", ""),
            "admin": is_admin(),
            "network": {
                "interface": snap.get("interface", ""),
                "connection": snap.get("connection", ""),
                "ssid": snap.get("ssid", ""),
                "signal": snap.get("signal"),
                "signal_dbm": snap.get("signal_dbm"),
                "security": snap.get("security", ""),
                "ip": snap.get("ip", ""),
                "prefix": snap.get("prefix"),
                "mac": snap.get("mac", ""),
                "gateway": snap.get("gateway", ""),
                "link_mbps": snap.get("link_mbps"),
                "frequency_mhz": snap.get("frequency_mhz"),
                "rx_bytes": snap.get("rx_bytes"),
                "tx_bytes": snap.get("tx_bytes"),
            },
            "dns": dns_state,
            "router": router_state,
            "scan": {
                "last_scan": int(self._last_scan),
                "scanning": self.scanner.scanning,
                "error": self._scan_error,
                "autorefresh_seconds": int((self.cfg.get("scan") or {}).get("autorefresh_seconds", 45)),
            },
        }

    def devices(self, refresh: bool = False) -> dict[str, Any]:
        snap = self._snapshot(force=refresh)
        ip = snap.get("ip", "")
        prefix = snap.get("prefix")
        gateway = snap.get("gateway", "")
        iface = snap.get("interface", "")

        cached = self.scanner.cached()
        stale = (time.time() - self._last_scan) > 20
        if (refresh or not cached) and ip:
            if not self.scanner.scanning:
                with self._scan_lock:
                    if not self.scanner.scanning:
                        try:
                            self.scanner.scan(ip, prefix, gateway, iface, snap.get("mac", ""))
                            self._scan_error = ""
                        except Exception as exc:  # keep the API alive
                            self._scan_error = str(exc)
                        self._last_scan = time.time()
            elif not cached:
                # A scan is already running; report what we have.
                pass

        devices = self._apply_labels(self._merge_router_devices(self.scanner.cached()))
        return {
            "devices": devices,
            "scanned_at": int(self._last_scan),
            "scanning": self.scanner.scanning,
            "stale": stale,
            "error": self._scan_error,
            "subnet": f"{ip}/{prefix}" if ip and prefix is not None else "",
        }

    def _apply_labels(self, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
        labels = config.load().get("labels") or {}
        for device in devices:
            mac = str(device.get("mac") or "").lower()
            device["label"] = labels.get(mac, "") if mac else ""
        return devices

    def set_device_label(self, body: dict[str, Any]) -> dict[str, Any]:
        mac = _normalize_mac(str(body.get("mac") or ""))
        if not mac:
            raise ApiError("A valid device MAC address is required.")
        label = re.sub(r"[\x00-\x1f\x7f]+", " ", str(body.get("label") or ""))
        label = re.sub(r"\s+", " ", label).strip()[:48]

        cfg = config.load()
        labels = dict(cfg.get("labels") or {})
        if label:
            labels[mac] = label
        else:
            labels.pop(mac, None)
        cfg["labels"] = labels
        config.save(cfg)
        self.cfg = cfg
        return {"ok": True, "mac": mac, "label": label}

    def scan(self) -> dict[str, Any]:
        # Force a fresh sweep from the UI button.
        self._last_scan = 0.0
        return self.devices(refresh=True)

    def start_speedtest(self) -> dict[str, Any]:
        return self.speedtest.start()

    def speedtest_status(self) -> dict[str, Any]:
        return self.speedtest.status()

    def set_dns(self, profile: str) -> dict[str, Any]:
        result = self.dns.apply(profile)
        if result.get("ok"):
            cfg = config.load()
            cfg["dns_profile"] = profile
            config.save(cfg)
            self.cfg = cfg
        return result

    def router_login(self, body: dict[str, Any]) -> dict[str, Any]:
        host = str(body.get("host") or "").strip() or default_gateway()
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        if not password:
            # "Reconnect" can reuse the password saved on this computer.
            saved_host, saved_user, saved_password = config.get_router_credentials()
            if saved_password:
                host = host or saved_host
                username = username or saved_user
                password = saved_password
        if not username or not password:
            raise ApiError("Router username and password are required.")
        try:
            info = self.router.connect(host, username, password)
        except RouterError as exc:
            raise ApiError(str(exc), 400, "Check the router address and credentials.") from exc
        remember = bool(body.get("remember", True))
        cfg = config.load()
        cfg["router"] = {
            "host": host,
            "username": username,
            "password": password if remember else "",
            "remember": remember,
        }
        config.save(cfg)
        self.cfg = cfg
        return info

    def router_selftest(self) -> dict[str, Any]:
        try:
            return self.router.selftest()
        except RouterError as exc:
            raise ApiError(str(exc), 400) from exc

    def router_diagnostics(self) -> dict[str, Any]:
        try:
            return self.router.diagnostics()
        except RouterError as exc:
            raise ApiError(str(exc), 400) from exc

    def router_logout(self) -> dict[str, Any]:
        self.router.disconnect()
        cfg = config.load()
        router = dict(cfg.get("router") or {})
        router["password"] = ""
        cfg["router"] = router
        config.save(cfg)
        self.cfg = cfg
        return {"ok": True}

    def set_device_access(self, body: dict[str, Any]) -> dict[str, Any]:
        mac = str(body.get("mac") or "").strip().lower()
        scope = str(body.get("scope") or "internet").strip().lower()
        allowed = bool(body.get("allowed"))
        if not mac:
            raise ApiError("A device MAC address is required.")

        # Never let the dashboard lock out the machine running it or the router.
        known = self._merge_router_devices(self.scanner.cached())
        for device in known:
            if device.get("mac") == mac and (device.get("is_self") or device.get("is_gateway")):
                raise ApiError("Refusing to change access for this computer or the router itself.")

        adapter = self.router.adapter()
        if adapter is None:
            raise ApiError(
                "Connect your router first to control device access.",
                409,
                "Open Settings and sign in to the router.",
            )
        try:
            return adapter.set_access(mac, scope, allowed)
        except Unsupported as exc:
            raise ApiError(str(exc), 501, "The router firmware does not expose this action.") from exc
        except RouterError as exc:
            raise ApiError(str(exc), 502) from exc

    def settings(self) -> dict[str, Any]:
        cfg = config.load()
        router = dict(cfg.get("router") or {})
        router["password"] = ""  # never send it back to the browser
        return {
            "router": router,
            "scan": cfg.get("scan", {}),
            "dns_profile": cfg.get("dns_profile", "familyshield"),
            "config_path": str(config.config_path()),
        }

    def save_settings(self, body: dict[str, Any]) -> dict[str, Any]:
        cfg = config.load()
        if "scan" in body and isinstance(body["scan"], dict):
            scan = dict(cfg.get("scan") or {})
            try:
                scan["autorefresh_seconds"] = max(10, min(600, int(body["scan"].get("autorefresh_seconds", 45))))
            except (TypeError, ValueError):
                pass
            cfg["scan"] = scan
            self.scanner.ping_timeout_ms = int(scan.get("ping_timeout_ms", 900))
        if "router" in body and isinstance(body["router"], dict):
            incoming = body["router"]
            router = dict(cfg.get("router") or {})
            if "host" in incoming:
                router["host"] = str(incoming["host"] or "").strip()
            if "username" in incoming:
                router["username"] = str(incoming["username"] or "").strip()
            if incoming.get("password"):
                router["password"] = str(incoming["password"])
            router["remember"] = bool(incoming.get("remember", router.get("remember", True)))
            cfg["router"] = router
        config.save(cfg)
        self.cfg = cfg
        return {"ok": True}
