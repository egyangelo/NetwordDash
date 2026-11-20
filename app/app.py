#!/usr/bin/env python3
"""NetDash entry point.

    python3 app.py                 # start and open the browser
    python3 app.py --port 9000     # pick a port
    python3 app.py --no-browser    # do not open a browser
"""

from __future__ import annotations

import argparse
import json
import sys
from getpass import getpass
from pathlib import Path

from netdash.netinfo import default_gateway
from netdash.router.zte import ZteRouter
from netdash.server import serve


def diagnose(host_flag: str = "", user_flag: str = "", debug: bool = False) -> int:
    """Sign in to the router and save the raw access-control responses.

    The password is read from the terminal and is never written to disk.
    """
    gateway = default_gateway() or "192.168.1.1"
    if host_flag:
        host = host_flag
    else:
        host = input(f"Router address [{gateway}]: ").strip() or gateway
    if user_flag:
        username = user_flag
    else:
        username = input("Username [admin]: ").strip() or "admin"
    password = getpass("Router password (hidden): ")
    if not password:
        print("No password entered.", file=sys.stderr)
        return 1

    router = ZteRouter(host, debug=debug)
    print(f"Connecting to {host} as {username!r} …")
    try:
        info = router.login(username, password)
    except Exception as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        print(
            "Hint: use the exact username shown on the router's login page "
            "(it is not always 'admin'), and wait 3 minutes if the router is locked.",
            file=sys.stderr,
        )
        return 1

    print(f"Connected to {info.get('model') or 'router'}.")
    for note in info.get("capabilities", {}).get("notes", []):
        print(f"  - {note}")

    data = router.diagnostics()
    target = Path("router-diagnostics.json")
    target.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:
        pass
    print(f"\nSaved diagnostics to {target.resolve()}")
    print("This file contains MAC/IP addresses but no password. Share it to add write support.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="A small cross-platform LAN dashboard.")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="sign in to the router, save raw access-control responses, then exit",
    )
    parser.add_argument("--router-host", default="", help="router address for --diagnose")
    parser.add_argument("--router-user", default="", help="router username for --diagnose")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="print the router request/response exchange (secrets redacted)",
    )
    args = parser.parse_args()

    if args.diagnose:
        return diagnose(args.router_host, args.router_user, args.debug)

    try:
        serve(host=args.host, port=args.port, open_browser=not args.no_browser)
    except PermissionError:
        print("Permission denied while starting the server. Try a different --port.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
