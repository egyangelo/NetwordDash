"""LAN device discovery: ping sweep + neighbour (ARP) table."""

from __future__ import annotations

import ipaddress
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .sysutil import IS_WINDOWS, run

_OUI: dict[str, str] | None = None
_OUI_LOCK = threading.Lock()


def _oui_lines() -> list[str]:
    # Zip-safe: works from source tree and from a .pyz.
    try:
        from importlib import resources as _resources

        data = (_resources.files("netdash") / "data" / "oui.txt").read_bytes()
        return data.decode("utf-8", errors="replace").splitlines()
    except Exception:
        pass
    try:
        path = Path(__file__).parent / "data" / "oui.txt"
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def _load_oui() -> dict[str, str]:
    global _OUI
    if _OUI is not None:
        return _OUI
    with _OUI_LOCK:
        if _OUI is not None:
            return _OUI
        table: dict[str, str] = {}
        for line in _oui_lines():
            line = line.rstrip("\n")
            if not line:
                continue
            prefix, _, vendor = line.partition("\t")
            if len(prefix) == 6 and vendor:
                table[prefix.upper()] = vendor
        _OUI = table
        return table


def _vendor(mac: str) -> str:
    hexmac = re.sub(r"[^0-9A-Fa-f]", "", mac).upper()
    if len(hexmac) < 6:
        return ""
    return _load_oui().get(hexmac[:6], "")


def vendor_for(mac: str) -> str:
    """Public wrapper used when merging router-reported clients."""
    return _vendor(mac)


def _is_local_admin(mac: str) -> bool:
    try:
        first = int(mac.replace("-", ":").split(":")[0], 16)
        return bool(first & 0x02)
    except (ValueError, IndexError):
        return False


_VENDOR_TYPES = [
    ("router", ("zte", "tp-link", "netgear", "d-link", "dlink", "asustek", "asus",
                "huawei", "technicolor", "sagemcom", "nokia", "arris", "ubiquiti",
                "mikrotik", "sagem", "calix", "fiberhome")),
    ("iot", ("espressif", "tuya", "shelly", "sonoff", "itead", "philips",
             "signify", "lifx", "nest labs", "amazon technologies", "ring",
             "wyze", "raspberry pi", "arduino", "particle")),
    ("printer", ("canon", "epson", "brother", "lexmark", "xerox", "kyocera")),
    ("console", ("sony interactive", "nintendo", "valve", "microsoft")),
    ("tv", ("roku", "vizio", "hisense", "tcl", "lg electronics", "samsung electronics",
            "google", "apple")),
    ("phone", ("xiaomi", "oneplus", "oppo", "vivo", "motorola", "realme",
               "transsion", "honor", "meizu")),
    ("computer", ("intel", "dell", "hewlett", "lenovo", "acer", "micro-star",
                  "gigabyte", "asrock", "raspberry", "framework", "supermicro")),
]


def device_type(vendor: str, mac: str) -> str:
    if _is_local_admin(mac):
        return "phone"
    low = vendor.lower()
    for kind, keys in _VENDOR_TYPES:
        if any(key in low for key in keys):
            return kind
    return "other"


def _ping(ip: str, timeout_ms: int) -> bool:
    if IS_WINDOWS:
        cmd = ["ping", "-n", "1", "-w", str(timeout_ms), ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, round(timeout_ms / 1000))), ip]
    return run(cmd, timeout=max(2.0, timeout_ms / 1000 + 1.5)).ok


def _arp_table() -> dict[str, dict[str, str]]:
    """Return {ip: {mac, state}} for the local subnet."""
    table: dict[str, dict[str, str]] = {}
    if IS_WINDOWS:
        r = run(["arp", "-a"], timeout=10)
        for line in (r.out or "").splitlines():
            match = re.match(
                r"^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F-]{17})\s+(\S+)", line
            )
            if match:
                table[match.group(1)] = {
                    "mac": match.group(2).replace("-", ":").lower(),
                    "state": match.group(3).lower(),
                }
        return table

    r = run(["ip", "neigh", "show"], timeout=8)
    for line in (r.out or "").splitlines():
        match = re.match(
            r"^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+(?:\s+lladdr\s+([0-9a-fA-F:]{17}))?\s+(\S+)",
            line,
        )
        if match:
            table[match.group(1)] = {
                "mac": (match.group(2) or "").lower(),
                "state": match.group(3).lower(),
            }
    if not table:  # fallback for systems without `ip neigh`
        r = run(["arp", "-an"], timeout=8)
        for line in (r.out or "").splitlines():
            match = re.search(r"\((\d{1,3}(?:\.\d{1,3}){3})\) at ([0-9a-fA-F:]{17})", line)
            if match:
                table[match.group(1)] = {"mac": match.group(2).lower(), "state": "reachable"}
    return table


def _subnet_hosts(ip: str, prefix: int | None) -> tuple[ipaddress.IPv4Network, list[str]]:
    if not ip or prefix is None:
        return ipaddress.ip_network("0.0.0.0/32"), []
    net = ipaddress.ip_network(f"{ip}/{prefix}", strict=False)
    # Keep sweeps bounded: a /24 around ourselves is plenty for a home LAN.
    if net.num_addresses > 1024:
        octets = ip.split(".")
        net = ipaddress.ip_network(".".join(octets[:3] + ["0"]) + "/24", strict=False)
    hosts = [str(h) for h in net.hosts()]
    return net, hosts


def _reverse_dns(ip: str) -> str:
    old = socket.getdefaulttimeout()
    try:
        socket.setdefaulttimeout(0.8)
        name, _, _ = socket.gethostbyaddr(ip)
        name = name.rstrip(".") if name else ""
        if name.startswith("_") or name in ("localhost", "localhost.localdomain"):
            return ""
        return name
    except (OSError, socket.error):
        return ""
    finally:
        socket.setdefaulttimeout(old)


class DeviceScanner:
    def __init__(self, ping_timeout_ms: int = 900):
        self.ping_timeout_ms = max(200, min(3000, int(ping_timeout_ms)))
        self._lock = threading.Lock()
        self._at = 0.0
        self._data: list[dict[str, Any]] = []
        self.scanning = False

    def cached(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._data)

    def scan(
        self,
        ip: str,
        prefix: int | None,
        gateway: str = "",
        iface: str = "",
        self_mac: str = "",
    ) -> list[dict[str, Any]]:
        with self._lock:
            self.scanning = True
        try:
            devices = self._scan(ip, prefix, gateway, self_mac)
        finally:
            with self._lock:
                self.scanning = False
            self._at = time.time()
        with self._lock:
            self._data = devices
        return devices

    def _scan(
        self, ip: str, prefix: int | None, gateway: str, self_mac: str = ""
    ) -> list[dict[str, Any]]:
        net, hosts = _subnet_hosts(ip, prefix)
        before = _arp_table()
        # A ping sweep leaves FAILED neighbour entries behind; ignore them.
        before = {k: v for k, v in before.items() if v.get("mac") and v.get("state") != "failed"}

        alive: set[str] = set()
        if hosts:
            with ThreadPoolExecutor(max_workers=64) as pool:
                futures = {pool.submit(_ping, host, self.ping_timeout_ms): host for host in hosts}
                for future in as_completed(futures):
                    if future.result():
                        alive.add(futures[future])

        arp = _arp_table()
        arp = {k: v for k, v in arp.items() if v.get("mac") and v.get("state") != "failed"}
        if self_mac and ip:
            arp.setdefault(ip, {"mac": self_mac, "state": "reachable"})
        now = time.time()

        # Names: reverse DNS is best-effort and bounded by the worker timeout.
        names: dict[str, str] = {}
        candidates = [h for h in arp if h != ip][:64]
        if candidates:
            pool = ThreadPoolExecutor(max_workers=10)
            futures = {pool.submit(_reverse_dns, host): host for host in candidates}
            try:
                for future in as_completed(futures, timeout=2.5):
                    try:
                        name = future.result()
                    except Exception:
                        name = ""
                    if name:
                        names[futures[future]] = name
            except TimeoutError:
                pass
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

        devices: list[dict[str, Any]] = []
        seen: set[str] = set()
        for host in sorted(arp, key=lambda a: tuple(int(p) for p in a.split("."))):
            entry = arp[host]
            mac = entry.get("mac", "")
            responded = host in alive
            devices.append(
                {
                    "ip": host,
                    "mac": mac,
                    "name": names.get(host, ""),
                    "vendor": _vendor(mac) if mac else "",
                    "type": device_type(_vendor(mac), mac) if mac else "other",
                    "online": responded or entry.get("state") in ("reachable", "delay", "probe"),
                    "responded": responded,
                    "state": entry.get("state", "unknown"),
                    "is_self": host == ip,
                    "is_gateway": host == gateway,
                    "random_mac": _is_local_admin(mac) if mac else False,
                    "source": "scan",
                    "last_seen": int(now),
                }
            )
            seen.add(host)

        # The gateway and this host should always be listed.
        for host, flag in ((gateway, "is_gateway"), (ip, "is_self")):
            if host and host not in seen:
                entry = before.get(host) or arp.get(host) or {}
                mac = entry.get("mac", "")
                devices.append(
                    {
                        "ip": host,
                        "mac": mac,
                        "name": names.get(host, ""),
                        "vendor": _vendor(mac) if mac else "",
                        "type": device_type(_vendor(mac), mac) if mac else "other",
                        "online": flag == "is_self",
                        "responded": flag == "is_self",
                        "state": entry.get("state", "unknown"),
                        "is_self": flag == "is_self",
                        "is_gateway": flag == "is_gateway",
                        "random_mac": _is_local_admin(mac) if mac else False,
                        "source": "scan",
                        "last_seen": int(now),
                    }
                )

        def rank(device: dict[str, Any]) -> tuple[int, bool, tuple[int, ...]]:
            if device["is_self"]:
                group = 0
            elif device["is_gateway"]:
                group = 1
            else:
                group = 2
            return (group, not device["online"], tuple(int(p) for p in device["ip"].split(".")))

        devices.sort(key=rank)
        return devices
