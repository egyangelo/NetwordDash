"""ZTE ZXHN router adapter (F-series web UI, e.g. F670L).

The web UI uses a challenge/response login and a small XML "menuData" API.
Reads are authenticated by the session cookie and must be preceded by the
matching menuView page. Writes carry the page's _sessionTmpToken and an
RSA-signed SHA-256 digest in the Check header.

Per-device access maps to two ZTE features:

* Internet -> firewall MAC filter (black list rule for the device MAC)
* Wi-Fi    -> WLAN access-control rule for the device's SSID

Both are reversible and only ever add/remove a rule for the exact MAC. If the
router is in white-list mode the adapter refuses instead of changing policy,
because that could cut off every other device.
"""

from __future__ import annotations

import hashlib
import html
import http.cookiejar
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

from .base import Capabilities, RouterAdapter, RouterError, Unsupported
from .rsa_pkcs1 import PublicKey

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Endpoints observed on ZTE F-series firmware.
TAG_WIFI_CLIENTS = "wlan_client_stat_lua.lua"
TAG_LAN_CLIENTS = "localnet_lan_info_lua"
TAG_MAC_FILTER = "net_macfilter_lua.lua"
TAG_FW_GLOBAL = "firewall_filterglobal_lua.lua"
TAG_FW_MACFILTER = "firewall_macfilterv3_lua.lua"
TAG_WLAN_ACL_POLICY = "wlan_macfilteraclpolicy_lua.lua"
TAG_WLAN_ACL_RULE = "wlan_macfilterrule_lua.lua"

PAGE_DEVICES = "localNetStatus"
PAGE_FIREWALL = "filterCriteria"
PAGE_WLAN = "wlanAdvanced"

# Public key embedded in the F670L web console, used for the Check header.
ROUTER_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodPTerkUVCYmv28SOfRV
7UKHVujx/HjCUTAWy9l0L5H0JV0LfDudTdMNPEKloZsNam3YrtEnq6jqMLJV4ASb
1d6axmIgJ636wyTUS99gj4BKs6bQSTUSE8h/QkUYv4gEIt3saMS0pZpd90y6+B/9
hZxZE/RKU8e+zgRqp1/762TB7vcjtjOwXRDEL0w71Jk9i8VUQ59MR1Uj5E8X3WIc
fYSK5RWBkMhfaTRM6ozS9Bqhi40xlSOb3GBxCmliCifOJNLoO9kFoWgAIw5hkSIb
GH+4Csop9Uy8VvmmB+B3ubFLN35qIa5OG5+SDXn4L7FeAA5lRiGxRi8tsWrtew8w
nwIDAQAB
-----END PUBLIC KEY-----"""


def _redact(text: str) -> str:
    """Hide secrets before printing a request or response."""
    text = re.sub(r'("sess_token"\s*:\s*")[^"]*', r"\1<redacted>", text)
    text = re.sub(r"(_sessionTOKEN=)[^&\s\"']+", r"\1<redacted>", text)
    text = re.sub(r"(_sessionTmpToken\s*=\s*[\"'])[^\"']*", r"\1<redacted>", text)
    text = re.sub(r"(Password=)[0-9a-fA-F]{32,}", r"\1<redacted>", text)
    return text


class ZteRouter(RouterAdapter):
    name = "ZTE"

    def __init__(self, host: str, debug: bool = False):
        # Accept "192.168.1.1", "https://192.168.1.1/" and "192.168.1.1:8080".
        clean = host.strip()
        clean = re.sub(r"^https?://", "", clean, flags=re.IGNORECASE)
        clean = clean.split("/", 1)[0].strip()
        super().__init__(clean or host)
        self.base = ""
        self.session_token = ""
        self.debug = debug
        self._logging_in = False
        self.tmp_token = ""
        self.last_write_response = ""
        self._username = ""
        self._password = ""
        self._cookies = http.cookiejar.CookieJar()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # Never send local router traffic through an HTTP(S) proxy.
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self._cookies),
            urllib.request.HTTPSHandler(context=ctx),
        )

    # -- transport ---------------------------------------------------------
    def _request(
        self,
        path: str,
        data: dict[str, str] | None = None,
        timeout: float = 10.0,
        raw_body: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> str:
        url = path if path.startswith("http") else f"{self.base}{path}"
        if raw_body is not None:
            body = raw_body.encode("utf-8")
        elif data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
        else:
            body = None
        request = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
        request.add_header("User-Agent", UA)
        request.add_header("Accept", "application/json, text/javascript, */*; q=0.01")
        request.add_header("X-Requested-With", "XMLHttpRequest")
        request.add_header("Referer", f"{self.base}/")
        request.add_header("Origin", self.base)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        if body is not None:
            request.add_header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        try:
            with self._opener.open(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
                if self.debug:
                    print(
                        f"  [router] {request.get_method()} {url} -> {response.status} "
                        f"({len(body)} bytes)",
                        file=sys.stderr,
                    )
                    print(f"  [router]   {_redact(body)[:500]}", file=sys.stderr)
                return body
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = _redact(exc.read().decode("utf-8", errors="replace"))[:300]
            except Exception:
                pass
            if self.debug:
                print(f"  [router] {request.get_method()} {url} -> HTTP {exc.code} {detail}", file=sys.stderr)
            raise RouterError(f"router returned HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RouterError(f"cannot reach router: {exc}") from exc

    def discover(self) -> dict[str, Any]:
        """Find the web UI scheme and model name."""
        # Chrome reaches the router over plain HTTP first, which stores an extra
        # SID cookie before the HTTPS redirect. Mirror that so the session looks
        # the same to the router.
        try:
            self._request(f"http://{self.host}/", timeout=6)
        except RouterError:
            pass

        errors = []
        for scheme in ("https", "http"):
            base = f"{scheme}://{self.host}"
            try:
                page = self._request(f"{base}/", timeout=6)
            except RouterError as exc:
                errors.append(str(exc))
                continue
            self.base = base
            match = re.search(r"<title>(.*?)</title>", page, re.IGNORECASE | re.DOTALL)
            if match:
                self.model = html.unescape(match.group(1)).strip()
            if "ZTE" in page or self.model:
                return {"base": base, "model": self.model}
            errors.append(f"{scheme}: not a recognised ZTE page")
        raise RouterError(errors[-1] if errors else "router did not respond")

    # -- auth --------------------------------------------------------------
    def login(self, username: str, password: str) -> dict[str, Any]:
        if self._logging_in:
            raise RouterError("login already in progress")
        self._logging_in = True
        try:
            return self._login(username, password)
        finally:
            self._logging_in = False

    def _login(self, username: str, password: str) -> dict[str, Any]:
        if not self.base:
            self.discover()

        # The first GET establishes the SID cookie.
        self._request("/", timeout=8)

        try:
            entry_raw = self._request(
                f"/?_type=loginData&_tag=login_entry&_={int(time.time() * 1000)}", timeout=8
            )
            entry = json.loads(entry_raw)
        except json.JSONDecodeError as exc:
            raise RouterError("unexpected response from router (not JSON)") from exc

        locked = _int(entry.get("lockingTime"))
        if locked > 0:
            raise RouterError(
                f"router is temporarily locked for {locked}s after failed attempts; wait and retry"
            )
        prompt = str(entry.get("promptMsg") or "").strip()
        if prompt:
            raise RouterError(prompt)

        session_token = str(entry.get("sess_token") or "")
        if not session_token:
            raise RouterError("router did not issue a session token")

        token_page = self._request(
            f"/?_type=loginData&_tag=login_token&_={int(time.time() * 1000)}", timeout=8
        )
        match = re.search(r">(\d+)<", token_page)
        if not match:
            raise RouterError("could not read the login challenge from the router")
        challenge = match.group(1)

        password_hash = hashlib.sha256((password + challenge).encode("utf-8")).hexdigest()
        response = self._request(
            "/?_type=loginData&_tag=login_entry",
            data={
                "action": "login",
                "Username": username,
                "Password": password_hash,
                "_sessionTOKEN": session_token,
            },
            timeout=12,
        )
        try:
            payload = json.loads(response)
        except json.JSONDecodeError as exc:
            raise RouterError("unexpected login response from router") from exc

        message = str(payload.get("loginErrMsg") or "").strip()
        prompt = str(payload.get("promptMsg") or "").strip()
        locked = _int(payload.get("lockingTime"))
        new_token = str(payload.get("sess_token") or "")
        if locked > 0:
            raise RouterError(f"router is temporarily locked for {locked}s after failed attempts")
        if message:
            raise RouterError(message)
        if prompt:
            raise RouterError(prompt)
        if not new_token:
            details = ", ".join(
                f"{key}={payload[key]!r}"
                for key in ("login_need_refresh", "lockingTime", "loginErrMsg")
                if key in payload
            )
            raise RouterError(f"login was rejected by the router ({details or 'no token returned'})")

        self.connected = True
        self._username = username
        self._password = password
        self.session_token = new_token
        # The browser reloads "/" when login_need_refresh is set. That reload is
        # what finalises the authenticated session and embeds _sessionTmpToken,
        # which every write request must send.
        try:
            page = self._request("/", timeout=8)
            self.tmp_token = _extract_tmp_token(page)
        except RouterError:
            pass
        self._probe()
        return self.status()

    def logout(self) -> None:
        try:
            self._request(
                "/?_type=loginData&_tag=logout_entry",
                data={"IF_LogOff": "1"},
                timeout=5,
            )
        except RouterError:
            pass
        self.connected = False
        self.session_token = ""

    def _authed(self, path: str, data: dict[str, str] | None = None, retry: bool = True) -> str:
        # ZTE authenticates menuData/menuView calls with the session cookie, not
        # with a _sessionTOKEN parameter. Adding the login token here makes the
        # router answer SessionTimeout even on a fresh session.
        sep = "&" if "?" in path else "?"
        url = f"{path}{sep}_={int(time.time() * 1000)}"
        text = self._request(url, data=data, timeout=12)
        if "SessionTimeout" in text and retry and self._password and not self._logging_in:
            # Session expired: log in again once, transparently.
            self.login(self._username, self._password)
            return self._authed(path, data=data, retry=False)
        return text

    # -- reads -------------------------------------------------------------
    def _probe(self) -> None:
        caps = Capabilities()
        notes: list[str] = []

        clients = self._data(TAG_WIFI_CLIENTS, "localNetStatus")
        caps.devices = bool(clients)
        if not clients:
            notes.append("Router did not return a client list.")

        global_cfg = self._data(TAG_FW_GLOBAL, PAGE_FIREWALL)
        fw_rules = self._data(TAG_FW_MACFILTER, PAGE_FIREWALL)

        caps.block = bool(global_cfg and fw_rules)
        caps.block_scope = "internet" if caps.block else ""
        if not caps.block:
            notes.append("Firewall MAC filter was not readable.")
        elif _get(_merge_instances(global_cfg), "MacFilterTarget", "") == "Permit":
            notes.append("Firewall MAC filter is in White List mode; blocking is disabled to protect other devices.")

        # This firmware ships with WLAN access-control editing disabled: the page
        # unbinds the rule Apply button and the policy endpoint rejects POSTs.
        caps.wifi = False
        notes.append(
            "This firmware disables WLAN access-control rule editing, so per-device "
            "Wi-Fi blocking is unavailable. Internet blocking works."
        )

        caps.notes = notes
        self.caps = caps

    def _warmup(self, page: str) -> str:
        """Open a menu page first: ZTE ties the data endpoints to that context."""
        try:
            return self._authed(f"/?_type=menuView&_tag={page}&Menu3Location=0")
        except RouterError:
            return ""

    def _data(self, tag: str, page: str = "") -> str:
        """Fetch a data endpoint, warming up its page when one is known."""
        if page:
            self._warmup(page)
        for kind in ("menuData", "vueData"):
            try:
                text = self._authed(f"/?_type={kind}&_tag={tag}")
            except RouterError:
                continue
            if "SessionTimeout" not in text and "<ajax_response" in text:
                return text
        return ""

    def devices(self) -> list[dict[str, Any]]:
        found: dict[str, dict[str, Any]] = {}
        self._warmup("localNetStatus")
        sources = (
            (TAG_WIFI_CLIENTS, "wifi", "localNetStatus"),
            ("accessdev_landevs_lua.lua", "lan", "localNetStatus"),
            ("status_lan_info_lua.lua", "lan", "localNetStatus"),
            (TAG_LAN_CLIENTS, "lan", "localNetStatus"),
        )
        for tag, kind, page in sources:
            text = self._data(tag, page)
            if not text:
                continue
            for entry in _instances(text):
                normalized = _normalize_client(entry, kind)
                if normalized and normalized["mac"]:
                    found[normalized["mac"]] = normalized

        blocked = {_entry_mac(rule) for rule in self._fw_rules()} - {""}
        wifi_blocked: set[str] = set()
        policies = _instances(self._data(TAG_WLAN_ACL_POLICY, PAGE_WLAN))
        if any(_get(p, "ACLPolicy", "") == "Ban" for p in policies):
            wifi_blocked = {
                _entry_mac(rule) for rule in _instances(self._data(TAG_WLAN_ACL_RULE, PAGE_WLAN))
            } - {""}

        for device in found.values():
            device["blocked"] = device["mac"] in blocked
            device["wifi_blocked"] = device["mac"] in wifi_blocked
        return list(found.values())

    def diagnostics(self) -> dict[str, Any]:
        """Raw responses that help add write support for a specific firmware."""
        out: dict[str, Any] = {
            "host": self.host,
            "model": self.model,
            "tmp_token_present": bool(self.tmp_token),
            "endpoints": {},
        }
        out["cookies"] = [c.name for c in self._cookies]

        # Page id -> the data endpoints each page is known to serve.
        pages = {
            "localNetStatus": (
                TAG_WIFI_CLIENTS,
                "accessdev_landevs_lua.lua",
                "status_lan_info_lua.lua",
                TAG_LAN_CLIENTS,
            ),
            "parentCtrl": (
                "net_parental_ctl_lua.lua",
                "firewall_parentctrl_lua.lua",
            ),
            "filterCriteria": (TAG_FW_GLOBAL, TAG_FW_MACFILTER),
            "wlanAdvanced": (TAG_WLAN_ACL_POLICY, TAG_WLAN_ACL_RULE),
        }
        for page, tags in pages.items():
            try:
                view = self._warmup(page)
            except RouterError as exc:
                view = f"ERROR: {exc}"
            out[f"view:{page}"] = _redact(view)
            for tag in tags:
                text = self._data(tag)
                out[f"data:{page}:{tag}"] = _redact(text)[:40000] if text else "<none>"

        # The authenticated main page holds the menu, the generic form code and
        # the _sessionTmpToken write token.
        try:
            out["main_page"] = _redact(self._request("/", timeout=12))[:400000]
        except RouterError as exc:
            out["main_page"] = f"ERROR: {exc}"
        return out

    # -- writes ------------------------------------------------------------
    def set_access(self, mac: str, scope: str, allowed: bool) -> dict[str, Any]:
        target = _normalize_mac(mac)
        if not target:
            raise RouterError("Invalid MAC address.")
        if not self.tmp_token:
            raise Unsupported("The router session is missing its write token; reconnect the router.")
        if scope == "wifi":
            raise Unsupported(
                "This firmware disables WLAN access-control rule editing, so "
                "per-device Wi-Fi blocking is unavailable. Use the Internet switch."
            )
        return self._set_internet_access(target, allowed)

    def _set_internet_access(self, mac: str, allowed: bool) -> dict[str, Any]:
        global_text = self._data(TAG_FW_GLOBAL, PAGE_FIREWALL)
        if not global_text:
            raise Unsupported("Firewall MAC filter data is not readable on this firmware.")
        global_cfg = _merge_instances(global_text)
        mode = _get(global_cfg, "MacFilterTarget", "Discard")
        if mode.lower() == "permit":
            raise Unsupported(
                "The router's MAC filter is in White List mode. Switching it to a black "
                "list could disconnect every other device, so NetDash will not change it."
            )
        rules = [r for r in self._fw_rules() if _entry_mac(r) == mac]

        if allowed:
            for rule in rules:
                self._delete_rule(TAG_FW_MACFILTER, rule, ("Name", "Type", "SrcMacAddr", "DstMacAddr", "Protocol"))
            verified = not any(_entry_mac(r) == mac for r in self._fw_rules())
            return {
                "ok": True, "scope": "internet", "allowed": True, "verified": verified,
                "message": "Internet access allowed." if rules else "Device was not blocked.",
            }

        if rules:
            return {"ok": True, "scope": "internet", "allowed": False, "verified": True,
                    "message": "Device is already blocked."}

        if _get(global_cfg, "MacFilterEnable", "0") != "1":
            fields = {
                "IF_ACTION": "Apply",
                "_InstID": _get(global_cfg, "_InstID", ""),
                "MacFilterEnable": "1",
                "MacFilterTarget": "Discard",
            }
            for key in ("UrlFilterEnable", "UrlFilterTarget"):
                if _get(global_cfg, key):
                    fields[key] = _get(global_cfg, key)
            self._post_signed(TAG_FW_GLOBAL, fields, PAGE_FIREWALL)

        fields = {
            "IF_ACTION": "Apply",
            "_InstID": "-1",
            "Name": f"NetDash {mac[-5:].replace(':', '')}",
            "Type": "Route",
            "SrcMacAddr": mac.upper(),
            "DstMacAddr": "00:00:00:00:00:00",
            "Protocol": "ALL",
        }
        for index, octet in enumerate(mac.split(":")):
            fields[f"sub_SrcMacAddr{index}"] = octet.upper()
        for index in range(6):
            fields[f"sub_DstMacAddr{index}"] = "00"
        self._post_signed(TAG_FW_MACFILTER, fields, PAGE_FIREWALL)

        verified = any(_entry_mac(r) == mac for r in self._fw_rules())
        return {"ok": True, "scope": "internet", "allowed": False, "verified": verified,
                "message": "Internet access blocked." if verified else "Router did not confirm the new rule."}

    def _set_wifi_access(self, mac: str, allowed: bool) -> dict[str, Any]:
        policy_text = self._data(TAG_WLAN_ACL_POLICY, PAGE_WLAN)
        rules_text = self._data(TAG_WLAN_ACL_RULE, PAGE_WLAN)
        if not policy_text or not rules_text:
            raise Unsupported("WLAN access-control data is not readable on this firmware.")
        policies = [
            policy for policy in _instances(policy_text)
            if any(key.lower() == "aclpolicy" for key in policy)
        ]
        if not policies:
            raise Unsupported("The router did not return any WLAN access-control policy.")
        rules = _instances(rules_text)

        ssid = ""
        interface_id = ""
        for device in self.devices():
            if device["mac"] == mac:
                ssid = device.get("ssid", "")
                interface_id = device.get("interface", "")
                break
        policy = _pick_policy(policies, interface_id, ssid)
        mode = _get(policy, "ACLPolicy", "Disabled")
        if mode.lower() == "allow":
            raise Unsupported(
                "WLAN access control is in White List mode. Switching it to a black list "
                "could disconnect other devices, so NetDash will not change it."
            )
        # The rule select lists SSIDs by AP id (DEV.WIFI.AP1); WLANViewName on
        # the policy points at the radio (DEV.WIFI.RD1), so use the policy _InstID.
        interface = _get(policy, "_InstID", "") or interface_id or "DEV.WIFI.AP1"
        matches = [
            rule for rule in rules
            if _entry_mac(rule) == mac
            and _get(rule, "Interface", interface) == interface
        ]

        if allowed:
            for rule in matches:
                self._delete_rule(TAG_WLAN_ACL_RULE, rule, ("Name", "Interface", "MACAddress"))
            verified = not any(_entry_mac(r) == mac for r in _instances(self._data(TAG_WLAN_ACL_RULE, PAGE_WLAN)))
            return {
                "ok": True, "scope": "wifi", "allowed": True, "verified": verified,
                "message": "Wi-Fi access allowed." if matches else "Device was not blocked.",
            }

        if matches:
            return {"ok": True, "scope": "wifi", "allowed": False, "verified": True,
                    "message": "Device is already blocked."}

        if mode.lower() != "ban":
            self._apply_acl_policy(policies, policy, "Ban")

        fields = {
            "IF_ACTION": "Apply",
            "_InstID": "-1",
            "Name": f"NetDash {mac[-5:].replace(':', '')}",
            "Interface": interface,
            "MACAddress": mac.upper(),
        }
        for index, octet in enumerate(mac.split(":")):
            fields[f"sub_MACAddress{index}"] = octet.upper()
        self._post_signed(TAG_WLAN_ACL_RULE, fields, PAGE_WLAN)

        verified = any(_entry_mac(r) == mac for r in _instances(self._data(TAG_WLAN_ACL_RULE, PAGE_WLAN)))
        return {"ok": True, "scope": "wifi", "allowed": False, "verified": verified,
                "message": "Wi-Fi access blocked." if verified else "Router did not confirm the new rule."}

    def selftest(self) -> dict[str, Any]:
        """Prove write support without touching a real device.

        Adds a rule for a reserved, non-existent MAC, deletes it again, and puts
        the router's global filter settings back exactly as they were.
        """
        fake = "02:00:00:00:00:01"
        result: dict[str, Any] = {"internet": {}, "wifi": {}, "token": {}, "restored": False, "errors": []}

        # Harmless probe: the language switch posts the token without a Check
        # header, so it isolates the token from the signature.
        try:
            self._refresh_write_token()
            body = f"IF_LanguageSwitch=English&_sessionTOKEN={self.tmp_token}"
            probe = self._request(
                "/?_type=hiddenData&_tag=switchlang_entry", raw_body=body, timeout=10
            )
            result["token"] = {
                "length": len(self.tmp_token),
                "printable": self.tmp_token.isprintable(),
                "ascii": self.tmp_token.isascii(),
                "response": _redact(probe)[:300],
            }
        except Exception as exc:
            result["token"] = {"error": str(exc)}

        global_text = self._data(TAG_FW_GLOBAL, PAGE_FIREWALL)
        cfg = _merge_instances(global_text) if global_text else {}
        orig_enable = _get(cfg, "MacFilterEnable", "0")
        orig_target = _get(cfg, "MacFilterTarget", "Discard")

        try:
            blocked = self._set_internet_access(fake, False)
            allowed = self._set_internet_access(fake, True)
            ok = bool(blocked.get("verified")) and bool(allowed.get("verified"))
            result["internet"] = {
                "ok": ok,
                "message": "Firewall MAC filter write and delete verified." if ok
                else (blocked.get("message") or allowed.get("message")),
            }
        except Exception as exc:
            result["internet"] = {
                "ok": False,
                "message": str(exc),
                "raw": _redact(self.last_write_response)[:500],
            }
            result["errors"].append(f"internet: {exc}")
        finally:
            if cfg:
                try:
                    fields = {
                        "IF_ACTION": "Apply",
                        "_InstID": _get(cfg, "_InstID", ""),
                        "MacFilterEnable": orig_enable,
                        "MacFilterTarget": orig_target,
                    }
                    for key in ("UrlFilterEnable", "UrlFilterTarget"):
                        if _get(cfg, key):
                            fields[key] = _get(cfg, key)
                    self._post_signed(TAG_FW_GLOBAL, fields, PAGE_FIREWALL)
                    result["restored"] = True
                except Exception as exc:
                    result["errors"].append(f"restore internet: {exc}")

        result["wifi"] = {
            "ok": False,
            "available": False,
            "message": "Unavailable: this firmware disables WLAN access-control rule editing.",
        }
        return result

    def _apply_acl_policy(
        self, policies: list[dict[str, str]], policy: dict[str, str], value: str
    ) -> None:
        """The ACL policy form is cloned per SSID, so writes use _<index> fields."""
        try:
            index = policies.index(policy)
        except ValueError:
            index = 0
        fields = {
            "IF_ACTION": "Apply",
            f"_InstID_{index}": _entry_id(policy),
            f"ACLPolicy_{index}": value,
            f"Btn_cancel_MACFilterACLPolicy_{index}": "",
            f"Btn_apply_MACFilterACLPolicy_{index}": "",
        }
        self._post_signed(TAG_WLAN_ACL_POLICY, fields, PAGE_WLAN)

    def _fw_rules(self) -> list[dict[str, str]]:
        return _instances(self._data(TAG_FW_MACFILTER, PAGE_FIREWALL))

    def _delete_rule(self, tag: str, rule: dict[str, str], keys: tuple[str, ...]) -> None:
        inst_id = _entry_id(rule)
        if not inst_id:
            raise RouterError("Could not find the router rule ID to delete.")
        fields = {"IF_ACTION": "Delete", "_InstID": inst_id}
        for key in keys:
            value = _get(rule, key)
            if value:
                fields[key] = value
        mac = _entry_mac(rule)
        prefix = "sub_SrcMacAddr" if tag == TAG_FW_MACFILTER else "sub_MACAddress"
        if mac:
            for index, octet in enumerate(mac.split(":")):
                fields[f"{prefix}{index}"] = octet.upper()
        page = PAGE_FIREWALL if tag == TAG_FW_MACFILTER else PAGE_WLAN
        self._post_signed(tag, fields, page)

    def _refresh_write_token(self) -> None:
        """Re-read the page token: ZTE rotates/expires it, so refresh per write."""
        try:
            page = self._request("/", timeout=8)
        except RouterError:
            return
        token = _extract_tmp_token(page)
        if token:
            self.tmp_token = token

    def _post_signed(self, tag: str, fields: dict[str, str], page: str = "") -> str:
        # Match encodeURIComponent, which is what the router's own JS uses.
        encode = lambda value: urllib.parse.quote(str(value), safe="!~*'()")
        last_error = ""
        for attempt in range(2):
            if attempt == 0:
                self._refresh_write_token()
            elif self._password:
                # Session or token expired: start a fresh login, then retry.
                self.login(self._username, self._password)
            if page:
                # Menu pages carry their own token/context; refresh both.
                view = self._warmup(page)
                token = _extract_tmp_token(view) if view else ""
                if token:
                    self.tmp_token = token
            if self.debug:
                print(
                    f"  [router] write {tag} token_len={len(self.tmp_token)} attempt={attempt + 1}",
                    file=sys.stderr,
                )

            body = "&".join(f"{encode(key)}={encode(value)}" for key, value in fields.items())
            if self.tmp_token:
                body += "&_sessionTOKEN=" + self.tmp_token
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            check = PublicKey.from_pem(ROUTER_PUBLIC_KEY).encrypt(digest.encode("ascii"))
            text = self._request(
                f"/?_type=menuData&_tag={tag}",
                raw_body=body,
                headers={"Check": check},
                timeout=15,
            )
            self.last_write_response = text

            lower = text.lower()
            if text.lstrip().lower().startswith(("<!doctype", "<html")):
                raise RouterError(
                    f"router returned an HTML error page for {tag} "
                    "(the endpoint is not valid for this firmware)"
                )
            if "expired" in lower or "sessiontimeout" in lower:
                last_error = "router session expired"
                continue

            error = _error_string(text)
            if error and error.upper() != "SUCC":
                raise RouterError(f"router rejected the change ({_describe_error(text)})")
            return text

        raise RouterError(
            f"router rejected the change ({last_error}); sign out of the router's "
            "web UI in other browsers and try again"
        )


def _extract_tmp_token(page: str) -> str:
    """Read the _sessionTmpToken embedded in the authenticated page.

    Some firmware writes the value as literal \\xHH escapes (what the browser's
    JS engine turns into characters); most write it as a plain string. Only
    unescape when escapes are actually present - hex-decoding a plain token
    silently corrupts it.
    """
    token = ""
    for raw in re.findall(r"_sessionTmpToken\s*=\s*[\"']([^\"']*)[\"']", page):
        if not raw:
            continue
        if r"\x" in raw:
            token = re.sub(r"\\x([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), raw)
        else:
            token = raw
    # The page fragment assigns it again after the shell; the last one wins.
    return token


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _normalize_mac(value: str) -> str:
    raw = re.sub(r"[^0-9a-fA-F]", "", value or "")
    if len(raw) != 12:
        return ""
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2)).lower()


def _entry_mac(entry: dict[str, str]) -> str:
    keys = sorted(
        entry,
        key=lambda k: (
            0 if k.lower() == "srcmacaddr"
            else 1 if k.lower() == "macaddress"
            else 2 if "mac" in k.lower()
            else 3
        ),
    )
    for key in keys:
        mac = _normalize_mac(entry.get(key, ""))
        if mac:
            return mac
    return ""


def _entry_id(entry: dict[str, str]) -> str:
    for key, value in entry.items():
        if key.lower() in ("_instid", "instid"):
            return str(value).strip()
    return ""


def _get(entry: dict[str, str], name: str, default: str = "") -> str:
    for key, value in entry.items():
        if key.lower() == name.lower():
            return (value or "").strip()
    return default


def _merge_instances(text: str) -> dict[str, str]:
    merged: dict[str, str] = {}
    for instance in _instances(text):
        merged.update(instance)
    return merged


def _pick_policy(
    policies: list[dict[str, str]], interface_id: str, ssid: str
) -> dict[str, str]:
    if interface_id:
        for policy in policies:
            if _get(policy, "_InstID") == interface_id:
                return policy
    if ssid:
        for policy in policies:
            alias = _get(policy, "Alias") or _get(policy, "SSID")
            if alias.casefold() == ssid.casefold():
                return policy
    return policies[0]


def _describe_error(text: str) -> str:
    try:
        root = ET.fromstring(text)
        parts = []
        for tag in ("IF_ERRORSTR", "IF_ERRORPARAM", "IF_ERRORTYPE"):
            value = (root.findtext(tag) or "").strip()
            if value and value.upper() != "SUCC":
                parts.append(f"{tag}={value}")
        return ", ".join(parts) or "unknown error"
    except ET.ParseError:
        return _redact(text)[:200]


def _error_string(text: str) -> str:
    try:
        root = ET.fromstring(text)
        return (root.findtext("IF_ERRORSTR") or "").strip()
    except ET.ParseError:
        pass
    try:
        data = json.loads(text)
        return str(data.get("IF_ERRORSTR") or data.get("error") or "").strip()
    except (json.JSONDecodeError, TypeError):
        return ""


# --------------------------------------------------------------------------- #
# XML helpers
# --------------------------------------------------------------------------- #

def _instances(text: str) -> list[dict[str, str]]:
    """Flatten ZTE's <Instance><ParaName>..<ParaValue>.. structure."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    out: list[dict[str, str]] = []
    for instance in root.iter("Instance"):
        names = [(node.text or "").strip() for node in instance.findall("ParaName")]
        values = [(node.text or "").strip() for node in instance.findall("ParaValue")]
        out.append(dict(zip(names, values)))
    return out


def _pick(entry: dict[str, str], *needles: str) -> str:
    # Exact field names first: "AliasName" must not satisfy a "name" lookup.
    for needle in needles:
        for key, value in entry.items():
            if key.lower() == needle:
                return (value or "").strip()
    for needle in needles:
        for key, value in entry.items():
            if needle in key.lower():
                return (value or "").strip()
    return ""


def _normalize_client(entry: dict[str, str], kind: str) -> dict[str, Any] | None:
    raw_mac = _pick(entry, "macaddress", "mac")
    mac = re.sub(r"[^0-9a-fA-F]", "", raw_mac).lower()
    if len(mac) != 12:
        return None
    mac = ":".join(mac[i : i + 2] for i in range(0, 12, 2))
    return {
        "mac": mac,
        "ip": _pick(entry, "ipaddress", "ipaddr", "ip"),
        "name": _pick(entry, "hostname", "devicename", "name", "host"),
        "ssid": _pick(entry, "ssid", "essid"),
        "interface": _pick(entry, "aliasname", "interface"),
        "signal": _pick(entry, "rssi", "signal"),
        "connection": kind,
        "source": "router",
        "raw": {k: v for k, v in entry.items() if v},
    }
