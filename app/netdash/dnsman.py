"""Switch the system DNS resolver between well-known profiles."""

from __future__ import annotations

from typing import Any

from .netinfo import NetworkInfo
from .sysutil import IS_WINDOWS, have, is_admin, run

PROFILES: dict[str, dict[str, Any]] = {
    "none": {
        "label": "Automatic",
        "hint": "Use the DNS servers handed out by your router (DHCP)",
        "servers": [],
    },
    "google": {
        "label": "Google",
        "hint": "8.8.8.8 - fast, no filtering",
        "servers": ["8.8.8.8", "8.8.4.4"],
    },
    "familyshield": {
        "label": "FamilyShield",
        "hint": "OpenDNS FamilyShield - blocks adult content",
        "servers": ["208.67.222.123", "208.67.220.123"],
    },
    "adguard": {
        "label": "AdGuard",
        "hint": "AdGuard DNS - blocks ads and trackers",
        "servers": ["94.140.14.14", "94.140.15.15"],
    },
    "cloudflare-malware": {
        "label": "Cloudflare Malware",
        "hint": "1.1.1.2 - blocks malware and phishing",
        "servers": ["1.1.1.2", "1.0.0.2"],
    },
    "cloudflare-family": {
        "label": "Cloudflare Family",
        "hint": "1.1.1.3 - blocks malware and adult content",
        "servers": ["1.1.1.3", "1.0.0.3"],
    },
}


def detect_profile(snapshot: dict[str, Any]) -> str:
    """Best guess at the configured profile from a network snapshot."""
    servers = list(snapshot.get("dns") or [])
    if snapshot.get("auto_dns") is True:
        return "none"
    return _match(servers)


def _match(servers: list[str]) -> str:
    normalized = {s.strip() for s in servers if s.strip()}
    if not normalized:
        return "none"
    for key, profile in PROFILES.items():
        if profile["servers"] and set(profile["servers"]) == normalized:
            return key
    for key, profile in PROFILES.items():
        if profile["servers"] and normalized & set(profile["servers"]):
            return key
    return "custom"


def _linux_connection(iface: str) -> str:
    r = run(["nmcli", "-t", "-f", "GENERAL.CONNECTION", "dev", "show", iface])
    if r.ok and ":" in r.out:
        return r.out.strip().split(":", 1)[1].strip()
    return ""


def _linux_apply(iface: str, servers: list[str]) -> dict[str, Any]:
    if not have("nmcli"):
        return {
            "ok": False,
            "error": "NetworkManager (nmcli) was not found.",
            "hint": "Install NetworkManager or switch DNS from your desktop settings.",
        }
    connection = _linux_connection(iface)
    if not connection:
        return {
            "ok": False,
            "error": f"Could not find the NetworkManager connection for {iface}.",
            "hint": "Make sure the interface is connected through NetworkManager.",
        }

    if servers:
        mod = run(
            ["nmcli", "con", "mod", connection, "ipv4.dns", " ".join(servers),
             "ipv4.ignore-auto-dns", "yes"],
            timeout=15,
        )
    else:
        mod = run(
            ["nmcli", "con", "mod", connection, "ipv4.dns", "",
             "ipv4.ignore-auto-dns", "no"],
            timeout=15,
        )
    if not mod.ok:
        message = (mod.err or mod.out or "nmcli failed").strip()
        return {
            "ok": False,
            "error": message.splitlines()[-1] if message else "nmcli failed",
            "hint": "This needs administrator rights. Start NetDash with sudo, "
                    "or approve the PolicyKit prompt when it appears.",
        }

    up = run(["nmcli", "con", "up", connection], timeout=30)
    if not up.ok:
        reapply = run(["nmcli", "dev", "reapply", iface], timeout=30)
        if not reapply.ok:
            message = (up.err or up.out or "could not reactivate connection").strip()
            return {"ok": False, "error": message.splitlines()[-1]}
    if have("resolvectl"):
        run(["resolvectl", "flush-caches"], timeout=8)
    return {"ok": True}


def _windows_apply(iface: str, servers: list[str]) -> dict[str, Any]:
    if not iface:
        return {"ok": False, "error": "No active network adapter was found."}
    if not servers:
        r = run(["netsh", "interface", "ipv4", "set", "dnsservers",
                 f"name={iface}", "source=dhcp"], timeout=15)
    else:
        r = run(["netsh", "interface", "ipv4", "set", "dnsservers",
                 f"name={iface}", "source=static", f"address={servers[0]}",
                 "register=primary", "validate=no"], timeout=15)
        if r.ok:
            for index, server in enumerate(servers[1:], start=2):
                r = run(["netsh", "interface", "ipv4", "add", "dnsservers",
                         f"name={iface}", f"address={server}", f"index={index}",
                         "validate=no"], timeout=15)
                if not r.ok:
                    break
    if not r.ok:
        return {
            "ok": False,
            "error": (r.err or r.out or "netsh failed").strip().splitlines()[-1],
            "hint": "Run NetDash as Administrator to change DNS settings.",
        }
    run(["ipconfig", "/flushdns"], timeout=10)
    return {"ok": True}


class DnsManager:
    def __init__(self, netinfo: NetworkInfo):
        self.netinfo = netinfo

    def state(self, iface: str = "") -> dict[str, Any]:
        snap = self.netinfo.snapshot()
        iface = iface or snap.get("interface", "")
        servers = list(snap.get("dns") or [])
        active = detect_profile(snap)
        return {
            "servers": servers,
            "profile": active,
            "profiles": PROFILES,
            "interface": iface,
            "admin": is_admin(),
        }

    def apply(self, profile_key: str) -> dict[str, Any]:
        profile = PROFILES.get(profile_key)
        if not profile:
            return {"ok": False, "error": f"Unknown DNS profile: {profile_key}"}

        snap = self.netinfo.snapshot(force=True)
        iface = snap.get("interface", "")
        result = _windows_apply(iface, profile["servers"]) if IS_WINDOWS else _linux_apply(iface, profile["servers"])

        if not result.get("ok"):
            return {**result, "profile": profile_key}

        # Give the resolver a moment, then report what actually took effect.
        latest = self.netinfo.snapshot(force=True)
        result["servers"] = latest.get("dns", [])
        result["profile"] = profile_key
        result["effective"] = detect_profile(latest)
        return result
