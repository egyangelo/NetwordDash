"""Read-only network information for Linux and Windows."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from .sysutil import IS_WINDOWS, have, run


def _clean(value: str | None) -> str:
    return (value or "").strip().strip('"').strip()


# --------------------------------------------------------------------------- #
# Linux
# --------------------------------------------------------------------------- #

def _linux_default_route() -> tuple[str, str]:
    """Return (device, gateway) for the default IPv4 route."""
    result = run(["ip", "-j", "route", "show", "default"])
    if result.ok:
        try:
            routes = json.loads(result.out or "[]")
            for route in routes:
                if route.get("dst") == "default":
                    return route.get("dev", ""), route.get("gateway", "")
        except json.JSONDecodeError:
            pass
    result = run(["ip", "route", "show", "default"])
    match = re.search(r"default via (\S+) dev (\S+)", result.out)
    if match:
        return match.group(2), match.group(1)
    return "", ""


def _linux_link(dev: str) -> dict[str, Any]:
    info: dict[str, Any] = {}
    result = run(["ip", "-j", "addr", "show", "dev", dev])
    if result.ok:
        try:
            data = json.loads(result.out or "[]")
            if data:
                link = data[0]
                info["mac"] = link.get("address", "")
                info["mtu"] = link.get("mtu")
                info["state"] = link.get("operstate", "")
                for addr in link.get("addr_info", []) or []:
                    if addr.get("family") == "inet" and not info.get("ip"):
                        info["ip"] = addr.get("local", "")
                        info["prefix"] = addr.get("prefixlen")
        except json.JSONDecodeError:
            pass
    return info


def _nmcli_split(line: str) -> list[str]:
    """Split nmcli's `-t` output, honouring backslash-escaped colons."""
    fields: list[str] = []
    buffer: list[str] = []
    escaped = False
    for char in line:
        if escaped:
            buffer.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append("".join(buffer))
            buffer = []
        else:
            buffer.append(char)
    fields.append("".join(buffer))
    return fields


def _channel_to_mhz(channel: int) -> float | None:
    if 1 <= channel <= 14:
        return 2407 + channel * 5
    if 32 <= channel <= 177:
        return 5000 + channel * 5
    return None


def _linux_wifi(dev: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if have("nmcli"):
        r = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,RATE,CHAN,SECURITY", "dev", "wifi"])
        for line in (r.out or "").splitlines():
            parts = _nmcli_split(line)
            if len(parts) < 6 or parts[0].strip() != "*":
                continue
            out["ssid"] = parts[1].strip()
            try:
                out["signal"] = int(parts[2])
            except ValueError:
                pass
            match = re.search(r"([\d.]+)", parts[3])
            if match:
                out["link_mbps"] = float(match.group(1))
            try:
                channel = int(parts[4])
                out["channel"] = channel
                frequency = _channel_to_mhz(channel)
                if frequency:
                    out["frequency_mhz"] = frequency
            except ValueError:
                pass
            out["security"] = parts[5].strip()
            return out
    if have("iw"):
        r = run(["iw", "dev", dev, "link"])
        if r.ok and "Connected to" in r.out:
            m = re.search(r"SSID:\s*(.+)", r.out)
            if m:
                out["ssid"] = _clean(m.group(1))
            m = re.search(r"signal:\s*(-?\d+)\s*dBm", r.out)
            if m:
                out["signal_dbm"] = int(m.group(1))
            m = re.search(r"bitrate:\s*([\d.]+)\s*MBit/s", r.out)
            if m:
                out["link_mbps"] = float(m.group(1))
            m = re.search(r"freq:\s*([\d.]+)", r.out)
            if m:
                out["frequency_mhz"] = float(m.group(1))
    return out


def _linux_connection(dev: str) -> dict[str, Any]:
    out: dict[str, Any] = {"dns": []}
    if not have("nmcli"):
        return out
    r = run(["nmcli", "-t", "-f", "GENERAL.CONNECTION", "dev", "show", dev])
    if r.ok:
        out["connection"] = _clean(r.out.split(":", 1)[-1])
    if out.get("connection"):
        r = run(["nmcli", "-t", "-f", "ipv4.ignore-auto-dns", "con", "show", out["connection"]])
        if r.ok:
            out["auto_dns"] = r.out.strip().endswith(":no")
    r = run(["nmcli", "-t", "-f", "IP4.DNS,IP4.GATEWAY", "dev", "show", dev])
    for line in (r.out or "").splitlines():
        if line.startswith("IP4.DNS["):
            value = line.split(":", 1)[-1].strip()
            if value:
                out["dns"].append(value)
    return out


def _linux_counters(dev: str) -> dict[str, Any]:
    base = Path("/sys/class/net") / dev
    out: dict[str, Any] = {}
    try:
        out["rx_bytes"] = int((base / "statistics" / "rx_bytes").read_text().strip())
        out["tx_bytes"] = int((base / "statistics" / "tx_bytes").read_text().strip())
    except (OSError, ValueError):
        pass
    try:
        out["link_speed_mbps"] = int((base / "speed").read_text().strip())
    except (OSError, ValueError):
        pass
    return out


# --------------------------------------------------------------------------- #
# Windows
# --------------------------------------------------------------------------- #

def _windows_ipconfig() -> str:
    r = run(["ipconfig", "/all"], timeout=12)
    return r.out or ""


def _windows_adapter_blocks(text: str) -> list[tuple[str, list[str]]]:
    """Split `ipconfig /all` into (adapter title, lines) blocks."""
    blocks: list[tuple[str, list[str]]] = []
    title = ""
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if line and not line.startswith(" ") and line.endswith(":"):
            if title:
                blocks.append((title, lines))
            title = line[:-1]
            lines = []
        elif title:
            lines.append(line)
    if title:
        blocks.append((title, lines))
    return blocks


def _mask_to_prefix(mask: str) -> int | None:
    try:
        return sum(bin(int(part)).count("1") for part in mask.split("."))
    except ValueError:
        return None


def _win_value(lines: list[str], label: str) -> str:
    pattern = re.compile(rf"^\s*{re.escape(label)}[\s.]*:\s*(.+)$", re.IGNORECASE)
    for line in lines:
        match = pattern.match(line)
        if match:
            return _clean(match.group(1))
    return ""


def _windows_info() -> dict[str, Any]:
    text = _windows_ipconfig()
    info: dict[str, Any] = {"dns": [], "interface": ""}
    for title, lines in _windows_adapter_blocks(text):
        gateway = _win_value(lines, "Default Gateway")
        if not gateway:
            continue
        first_gw = gateway.split()[0]
        if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", first_gw):
            continue
        # ipconfig titles look like "Wireless LAN adapter Wi-Fi"; netsh wants
        # the connection name ("Wi-Fi") on its own.
        title_match = re.match(r"^.*?\badapter\s+(.+)$", title, re.IGNORECASE)
        info["interface"] = title_match.group(1).strip() if title_match else title
        info["adapter_title"] = title
        info["description"] = _win_value(lines, "Description")
        ipv4 = _win_value(lines, "IPv4 Address")
        info["ip"] = ipv4.split("(")[0].strip()
        info["gateway"] = first_gw
        info["mac"] = _win_value(lines, "Physical Address").replace("-", ":").lower()
        subnet = _win_value(lines, "Subnet Mask")
        info["subnet_mask"] = subnet
        info["prefix"] = _mask_to_prefix(subnet)
        # DNS servers are printed as a header followed by indented addresses.
        collecting = False
        for line in lines:
            if re.match(r"^\s*DNS Servers[\s.]*:", line, re.IGNORECASE):
                value = line.split(":", 1)[-1].strip()
                if value:
                    info["dns"].append(value)
                collecting = True
                continue
            if collecting:
                value = line.strip()
                if re.match(r"^[0-9a-fA-F:.]+$", value) and len(value) < 46:
                    info["dns"].append(value)
                else:
                    collecting = False
        break
    # Wi-Fi details.
    if have("netsh"):
        r = run(["netsh", "wlan", "show", "interfaces"], timeout=8)
        if r.ok:
            for line in r.out.splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                key = key.strip().lower()
                value = _clean(value)
                if key == "ssid" and "bssid" not in line.lower():
                    info["ssid"] = value
                elif key == "signal":
                    match = re.search(r"(\d+)", value)
                    if match:
                        info["signal"] = int(match.group(1))
                elif key.startswith("radio type"):
                    info["radio_type"] = value
                elif key.startswith("receive rate"):
                    match = re.search(r"([\d.]+)", value)
                    if match:
                        info["link_mbps"] = float(match.group(1))
    # Per-interface counters via PowerShell (available on Win10/11).
    if info.get("interface") and have("powershell"):
        safe = info["interface"].replace("'", "''")
        cmd = (
            "$s=Get-NetAdapterStatistics -Name '" + safe + "' -ErrorAction SilentlyContinue;"
            "if($s){$o=Get-NetAdapter -Name '" + safe + "';"
            "$s|Select-Object ReceivedBytes,SentBytes|ConvertTo-Json -Compress}"
        )
        r = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], timeout=12)
        if r.ok and r.out.strip():
            try:
                stats = json.loads(r.out)
                info["rx_bytes"] = int(stats.get("ReceivedBytes") or 0)
                info["tx_bytes"] = int(stats.get("SentBytes") or 0)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
    return info


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

class NetworkInfo:
    """Caches a snapshot for a couple of seconds to keep the UI snappy."""

    def __init__(self, ttl: float = 3.0):
        self.ttl = ttl
        self._at = 0.0
        self._data: dict[str, Any] = {}

    def snapshot(self, force: bool = False) -> dict[str, Any]:
        if not force and self._data and (time.time() - self._at) < self.ttl:
            return self._data
        data = self._collect()
        self._data = data
        self._at = time.time()
        return data

    def _collect(self) -> dict[str, Any]:
        if IS_WINDOWS:
            data = _windows_info()
        else:
            dev, gateway = _linux_default_route()
            data = {"interface": dev, "gateway": gateway}
            if dev:
                data.update(_linux_link(dev))
                data.update(_linux_wifi(dev))
                data.update(_linux_connection(dev))
                data.update(_linux_counters(dev))
        data.setdefault("dns", [])
        data["platform"] = "windows" if IS_WINDOWS else "linux"
        data["hostname"] = _hostname()
        return data


def _hostname() -> str:
    import socket

    try:
        return socket.gethostname()
    except OSError:
        return ""


def default_gateway() -> str:
    if IS_WINDOWS:
        return _windows_info().get("gateway", "")
    return _linux_default_route()[1]
