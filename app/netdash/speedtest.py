"""A small internet speed test (latency, download, upload).

Uses Cloudflare's public speed-test endpoints. The backend performs the
transfers so the numbers are not distorted by browser CORS, extensions or
per-request overhead.

The download is time-capped instead of size-capped so a slow line does not turn
a test into a minute-long wait; the upload size scales with the measured
download rate for a useful sample on both slow and fast links.
"""

from __future__ import annotations

import http.client
import socket
import ssl
import threading
import time
from typing import Any

HOST = "speed.cloudflare.com"
USER_AGENT = "NetDash/1.0 (+local speed test)"


def _https(timeout: float) -> http.client.HTTPSConnection:
    return http.client.HTTPSConnection(
        HOST, 443, timeout=timeout, context=ssl.create_default_context()
    )


def measure_latency(samples: int = 5) -> tuple[float, float]:
    """TCP connect round-trips to the speed host, in milliseconds."""
    values: list[float] = []
    for _ in range(samples):
        started = time.monotonic()
        try:
            with socket.create_connection((HOST, 443), timeout=3):
                pass
        except OSError as exc:
            if values:
                break
            raise RuntimeError(f"cannot reach {HOST}: {exc}") from exc
        values.append((time.monotonic() - started) * 1000)
    if not values:
        raise RuntimeError("latency measurement failed")
    average = sum(values) / len(values)
    jitter = (
        sum(abs(values[i] - values[i - 1]) for i in range(1, len(values)))
        / max(1, len(values) - 1)
    )
    return average, jitter


def measure_download(max_seconds: float = 8.0) -> float:
    """Download until the time cap and return megabits per second."""
    conn = _https(timeout=max_seconds + 5)
    try:
        conn.request(
            "GET",
            "/__down?bytes=50000000",
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"},
        )
        response = conn.getresponse()
        if response.status != 200:
            raise RuntimeError(f"download endpoint returned HTTP {response.status}")
        started = time.monotonic()
        total = 0
        while time.monotonic() - started < max_seconds:
            chunk = response.read(262144)
            if not chunk:
                break
            total += len(chunk)
        elapsed = time.monotonic() - started
    finally:
        conn.close()
    if total <= 0 or elapsed <= 0:
        raise RuntimeError("download measured no data")
    return (total * 8) / elapsed / 1_000_000


def _upload_once(size: int, timeout: float) -> tuple[float, float]:
    payload = b"\0" * size
    conn = _https(timeout=timeout)
    try:
        started = time.monotonic()
        conn.request(
            "POST",
            "/__up",
            body=payload,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(payload)),
            },
        )
        response = conn.getresponse()
        response.read()
        if response.status not in (200, 204):
            raise RuntimeError(f"upload endpoint returned HTTP {response.status}")
        elapsed = time.monotonic() - started
    finally:
        conn.close()
    if elapsed <= 0:
        raise RuntimeError("upload measured no time")
    return (size * 8) / elapsed / 1_000_000, elapsed


def measure_upload(download_mbps: float) -> float:
    """Start small (slow lines), then scale up when the first sample was fast."""
    speed, elapsed = _upload_once(1_000_000, timeout=20)
    if elapsed < 0.5:
        speed, elapsed = _upload_once(4_000_000, timeout=25)
        if elapsed < 0.5:
            speed, _ = _upload_once(8_000_000, timeout=30)
    return speed


class SpeedTest:
    """Runs one test at a time in a background thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.running = False
        self.phase = ""
        self.result: dict[str, Any] | None = None
        self.error = ""
        self.started_at = 0.0
        self.finished_at = 0.0

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self.running:
                return {"started": False, "running": True}
            self.running = True
            self.phase = "latency"
            self.error = ""
            self.started_at = time.time()
        threading.Thread(target=self._run, name="speedtest", daemon=True).start()
        return {"started": True, "running": True}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "phase": self.phase,
                "result": self.result,
                "error": self.error,
                "started_at": int(self.started_at) if self.started_at else 0,
                "finished_at": int(self.finished_at) if self.finished_at else 0,
                "server": HOST,
            }

    def _set_phase(self, phase: str) -> None:
        with self._lock:
            self.phase = phase

    def _run(self) -> None:
        try:
            ping, jitter = measure_latency()
            self._set_phase("download")
            download = measure_download()
            self._set_phase("upload")
            upload = measure_upload(download)
            result = {
                "ping_ms": round(ping, 1),
                "jitter_ms": round(jitter, 1),
                "download_mbps": round(download, 1),
                "upload_mbps": round(upload, 1),
                "server": "Cloudflare",
                "tested_at": int(time.time()),
            }
            with self._lock:
                self.result = result
        except Exception as exc:  # report any failure in the UI
            with self._lock:
                self.error = str(exc)
        finally:
            with self._lock:
                self.running = False
                self.phase = ""
                self.finished_at = time.time()
