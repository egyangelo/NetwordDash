"""Local HTTP server: static UI plus a small JSON API."""

from __future__ import annotations

import json
import mimetypes
import secrets
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import config
from .api import ApiError, App

try:
    from importlib import resources as _resources

    _STATIC_TRAVERSABLE = _resources.files("netdash") / "static"
    _USE_RESOURCES = True
except Exception:  # pragma: no cover - very old Python
    _USE_RESOURCES = False

STATIC_DIR = Path(__file__).parent / "static"
TOKEN_PLACEHOLDER = "__NETDASH_TOKEN__"


def _read_static_bytes(name: str) -> bytes | None:
    """Read a bundled static file, working both from source and from a .pyz."""
    if _USE_RESOURCES:
        try:
            target = _STATIC_TRAVERSABLE / name  # type: ignore[operator]
            if target.is_file():  # type: ignore[attr-defined]
                return target.read_bytes()  # type: ignore[attr-defined]
            return None
        except Exception:
            return None
    try:
        target = (STATIC_DIR / name).resolve()
        target.relative_to(STATIC_DIR.resolve())
    except ValueError:
        return None
    try:
        if target.is_file():
            return target.read_bytes()
    except OSError:
        return None
    return None


def _read_static_text(name: str) -> str | None:
    data = _read_static_bytes(name)
    if data is None:
        return None
    return data.decode("utf-8")


class NetDashServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], app: App, token: str):
        super().__init__(address, Handler)
        self.app = app
        self.token = token
        # Use the actually-bound port: when the requested port is busy we
        # fall back to port 0 (ephemeral), and address[1] would be stale.
        bound_port = self.server_address[1]
        self.allowed_hosts = {
            f"127.0.0.1:{bound_port}",
            f"localhost:{bound_port}",
            f"{address[0]}:{bound_port}",
        }

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class Handler(BaseHTTPRequestHandler):
    server_version = "NetDash"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # Keep the console readable; errors are reported by the API itself.
        pass

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
            )
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The browser navigated away or reloaded mid-response; nothing to do.
            self.close_connection = True

    def _json(self, status: int, payload: Any, extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _error(self, status: int, message: str, hint: str = "") -> None:
        self._json(status, {"error": message, "hint": hint})

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        return host in self.server.allowed_hosts  # type: ignore[attr-defined]

    def _token_ok(self) -> bool:
        supplied = self.headers.get("X-Netdash-Token") or ""
        return secrets.compare_digest(supplied, self.server.token)  # type: ignore[attr-defined]

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin == self.server.origin  # type: ignore[attr-defined]

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > 1_000_000:
            raise ApiError("Request body is too large.", 413)
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError("Malformed JSON body.", 400) from exc
        if not isinstance(data, dict):
            raise ApiError("JSON body must be an object.", 400)
        return data

    # -- routes ------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._error(403, "Invalid host header.")
            return
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            self._serve_index()
            return
        if path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
            return
        if path.startswith("/api/"):
            if not self._token_ok():
                self._error(403, "Missing or invalid session token.")
                return
            query = urllib.parse.parse_qs(parsed.query)
            self._api_get(path, query)
            return
        self._error(404, "Not found.")

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._error(403, "Invalid host header.")
            return
        if not self._token_ok() or not self._origin_ok():
            self._error(403, "Missing or invalid session token.")
            return
        parsed = urllib.parse.urlsplit(self.path)
        content_type = (self.headers.get("Content-Type") or "").lower()
        if "application/json" not in content_type:
            self._error(415, "Expected application/json.")
            return
        try:
            body = self._body()
            result = self._api_post(parsed.path, body)
        except ApiError as exc:
            self._error(exc.status, exc.message, exc.hint)
            return
        except Exception as exc:  # pragma: no cover - defensive
            self._error(500, f"Unexpected error: {exc}")
            return
        self._json(200, result)

    # -- API implementation ------------------------------------------------
    def _api_get(self, path: str, query: dict[str, list[str]]) -> None:
        try:
            if path == "/api/state":
                self._json(200, self.app.state())
            elif path == "/api/devices":
                refresh = (query.get("refresh") or ["0"])[0] in ("1", "true", "yes")
                self._json(200, self.app.devices(refresh=refresh))
            elif path == "/api/settings":
                self._json(200, self.app.settings())
            elif path == "/api/router/diagnostics":
                self._json(200, self.app.router_diagnostics())
            elif path == "/api/speedtest/status":
                self._json(200, self.app.speedtest_status())
            else:
                self._error(404, "Unknown API endpoint.")
        except ApiError as exc:
            self._error(exc.status, exc.message, exc.hint)
        except Exception as exc:
            self._error(500, str(exc))

    def _api_post(self, path: str, body: dict[str, Any]) -> Any:
        if path == "/api/devices/scan":
            return self.app.scan()
        if path == "/api/dns":
            profile = str(body.get("profile") or "").strip()
            result = self.app.set_dns(profile)
            if not result.get("ok"):
                raise ApiError(
                    result.get("error") or "Could not change DNS.",
                    400,
                    result.get("hint", ""),
                )
            return result
        if path == "/api/router/login":
            return self.app.router_login(body)
        if path == "/api/router/logout":
            return self.app.router_logout()
        if path == "/api/router/selftest":
            return self.app.router_selftest()
        if path == "/api/device/access":
            return self.app.set_device_access(body)
        if path == "/api/device/label":
            return self.app.set_device_label(body)
        if path == "/api/device/type":
            return self.app.set_device_type(body)
        if path == "/api/speedtest/start":
            return self.app.start_speedtest()
        if path == "/api/settings":
            return self.app.save_settings(body)
        raise ApiError("Unknown API endpoint.", 404)

    # -- static files ------------------------------------------------------
    def _serve_index(self) -> None:
        html = _read_static_text("index.html")
        if html is None:
            self._error(500, "UI files are missing.")
            return
        html = html.replace(TOKEN_PLACEHOLDER, self.server.token)  # type: ignore[attr-defined]
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _serve_static(self, name: str) -> None:
        name = urllib.parse.unquote(name).lstrip("/").replace("\\", "/")
        parts = [p for p in name.split("/") if p not in ("", ".")]
        if not parts or ".." in parts or name.startswith("."):
            self._error(403, "Forbidden.")
            return
        safe = "/".join(parts)
        data = _read_static_bytes(safe)
        if data is None:
            self._error(404, "Not found.")
            return
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        self._send(200, data, ctype)


def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    app = App()
    token = secrets.token_urlsafe(24)

    try:
        server = NetDashServer((host, port), app, token)
    except OSError:
        server = NetDashServer((host, 0), app, token)

    actual_port = server.server_address[1]
    url = f"http://{host}:{actual_port}/"

    print("  NetDash is running")
    print(f"  URL: {url}")
    print(f"  Settings: {config.config_path()}")
    print("  Press Ctrl+C to stop.\n")

    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopping NetDash.")
    finally:
        server.shutdown()
        server.server_close()
