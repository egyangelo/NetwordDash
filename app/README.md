# NetDash

A small, local network dashboard for Linux and Windows. It shows your current
connection, lists the devices on your LAN, and switches your system DNS with one
click.

No third-party packages, no cloud service, no telemetry. Just Python 3 and your
browser.

![NetDash dashboard: connection, this computer, gateway and DNS summary above the device list](netdash/docs/screen-04.png)

## Quick start

Run the launcher in the repository root:

```bash
# Linux
./linux-run.sh

# Windows
windows-run.bat
```

The dashboard opens at <http://127.0.0.1:8765/>. The server binds to localhost
only. Both launchers pass their arguments through, so:

```bash
./linux-run.sh --port 9000     # use another port
./linux-run.sh --no-browser    # do not open a browser
```

Requires Python 3.10 or newer. Everything else is part of the standard library.

## What it does

| Area | Details |
| --- | --- |
| Connection | SSID, security, signal strength, link rate, channel, interface, MAC, local IP |
| Traffic | Total received/sent bytes for the active interface |
| Appearance | Light and dark themes, or follow the system; remembered per browser |
| Devices | Ping sweep + ARP/neighbour table, vendor lookup from the bundled IEEE OUI registry, best-effort hostnames |
| 3D map | Navigable perspective view: router and devices as shapes, animated links, click-to-inspect details, per-link internet switch |
| Device types | Auto-detected from hostname and vendor, with a manual per-device type override |
| Labels | Custom device names keyed to the MAC address, stored locally |
| Privacy | Optional masking of device MAC addresses; hover, tap or focus reveals one |
| Sorting | Sort the table by Device, Address, Type, or Status; click again to reverse |
| DNS | Switch between Automatic (DHCP), Google, FamilyShield, AdGuard, Cloudflare Malware and Cloudflare Family |
| Speed test | Ping/jitter, download and upload against Cloudflare's public speed endpoints |
| Router | Optional ZTE login, model detection, router-side client list |
| Device access | Per-device **Internet** switch written to the router (Wi-Fi where the firmware allows it) |
| Packaging | One Python process, one HTML/CSS/JS page, works offline |

## Device labels

Labels appear as a badge next to the real device name, styled like the `YOU`
and `ROUTER` tags. The hostname itself stays read-only.

Click the pencil that appears on hover (or is always visible on touch screens)
to add or change a label. Press **Enter** to save, **Esc** to cancel, or save an
empty value to clear it.

Labels are keyed to the normalized MAC address and stored in
`~/.config/netdash/config.json`, so they survive IP changes and restarts. They
are local to NetDash and are never written to the router. The search box matches
labels too. When a label names a device clearly (`Smart Light`, `Samsung TV`,
`Xbox`, `DoorBell`), the 3D map uses it to pick the matching figure.

## Appearance

Use the **Auto / Light / Dark** switch in the header. Auto follows the operating
system and updates live if it changes; Light and Dark stay put. The choice is
stored in the browser, and the 3D map re-themes with the rest of the page.

**Settings → Display** holds the per-browser display options: whether device
MAC addresses are shown or masked, and the device icon size (100% down to 50%).
The icon size applies to the device chips in the table and to the shapes in
both 3D layouts.

## 3D network map

The **3D Map** tab turns the device list into a navigable scene. The router sits
at the centre as a hub, and every other device orbits it as a shape chosen for
its type: desktops, laptops, tablets, phones, TVs, IP cameras and doorbells,
smart lights, speakers, printers, and gamepads for Xbox, PlayStation and other
consoles. Anything unrecognised becomes a cube. The scene spans the full browser
width and height below the header in the normal 3D tab (the footer is hidden
there); the expand button makes it truly fullscreen.

![The same network in the default orbit layout](netdash/docs/screen-01.png)

![The same network in tree layout: every device on its own offset branch](netdash/docs/screen-02.png)

Devices are classified from their hostname and vendor — `LAPTOP-…`, `iPad`,
`Galaxy-Tab`, `iPhone`, `Samsung TV`, `Smart Light`, `DoorBell`, `Xbox-…`,
`PlayStation`, `HomePod`, and similar names map to their own figures. Detection
is a guess: each device row and 3D detail panel has a **Type** selector. Pick a
category to override it, or **Auto** to restore detection. Overrides are stored
locally by MAC address and never written to the router.

Devices are spread over concentric rings, with each outer ring sitting in the
angular gaps of the ring inside it, so the links stay separated instead of
overlapping. In dense views, labels that would collide are skipped; hover or
click a figure to identify it.

- **Layout:** the **Orbit / Tree** switch in the top-right corner changes the
  arrangement. **Orbit** is the radial map around the router; **Tree** arranges
  the devices in a grid under the router, one branch per device. Each branch
  leaves the router in its own lane, turns at its own height in the row, and
  drops into the device in that device's colour, so no two lines sit on top of
  each other. Tree view is remembered per browser, and auto-rotation is
  switched off there because a spinning flat tree reads as noise.
- **Orbit:** drag. **Pan:** Shift-drag or right-drag. **Zoom:** scroll or pinch.
  Arrow keys orbit, `+` / `-` zoom, and `0` or `R` resets the camera.
- **Full screen:** the expand button in the top-right corner (or `F` while the
  map has focus) fills the display; press `Esc` or the same button to return.
- **Links:** each device has a link to the router. Click the link itself to
  disconnect or reconnect its internet access through the router's MAC filter
  (the same action as the table's **Internet** switch). Connected links show no
  badge; a disconnected link shows a small plug glyph you can click to
  reconnect. Hovering a link shows its action.
- **Offline filter:** the eye button hides offline devices from the map; the
  choice is remembered on this computer.
- **Focus:** click one or more categories in the bottom legend to dim every
  other device type and highlight them. Click an active category again to
  remove it, or **Clear** to show everything. Categories with no devices are
  hidden from the legend.
- **Details:** click any figure to open a panel with its address, MAC, vendor,
  type, connection, how it was discovered, last-seen time, and access switches.
  **Center in view** flies the camera to the device; **Rename** edits the local
  label.
- **Live:** device positions, labels, and link state follow the normal scan
  refresh. The view fits itself to the screen until you zoom or pan, and
  **Reset view** restores the fit.

The renderer is small vanilla JavaScript on a 2D canvas with a perspective
camera; it uses no WebGL and no third-party library, so the app stays offline
and single-file. `prefers-reduced-motion` disables the drifting shapes and
moving link particles.

## DNS profiles

| Profile | Servers |
| --- | --- |
| Automatic | cleared, uses the router's DHCP values |
| Google | 8.8.8.8, 8.8.4.4 |
| FamilyShield | 208.67.222.123, 208.67.220.123 |
| AdGuard | 94.140.14.14, 94.140.15.15 |
| Cloudflare Malware | 1.1.1.2, 1.0.0.2 |
| Cloudflare Family | 1.1.1.3, 1.0.0.3 |

The app applies DNS through NetworkManager (`nmcli`) on Linux and `netsh` on
Windows. The connection is re-applied, so expect a one-second blip.

Changing DNS needs administrator rights:

- **Linux:** start the app with `sudo ./linux-run.sh`, or let your desktop's
  PolicyKit prompt appear (works on most Mint/Ubuntu setups).
- **Windows:** run the terminal as Administrator.

The current DNS servers are read back after the change, so the UI only reports
success when the setting actually took effect.

## Speed test

Click **Run speed test**. The backend measures TCP latency (5 samples) and
jitter, then a time-capped download and an upload whose size scales with the
measured download rate. Results are shown as ping, download and upload, with
live phase text while it runs.

It uses Cloudflare's public endpoints (`speed.cloudflare.com`), so the test
traffic goes to Cloudflare. Expect roughly 10-30 MB of data and 10-40 seconds
depending on the line. The last result stays in memory until the app restarts.

![DNS profiles and speed-test results](netdash/docs/screen-05.png)

## Router control

A normal client PC cannot cut another device's traffic by itself; only the
router can. NetDash therefore signs in to the router and uses its own features:

| Switch | Router feature | Effect |
| --- | --- | --- |
| **Internet** | Firewall MAC filter, black-list mode | Blocks routed traffic (internet) for that MAC |
| **Wi-Fi** | WLAN access control, black-list rule | Blocks that MAC from joining the device's SSID — only on firmware that allows editing it |

Each toggle adds or removes exactly one rule for the selected MAC and is
reversible by toggling back. The adapter:

- refuses to touch the filter when the router is in **white-list** mode,
  because flipping it could disconnect every other device;
- never changes the machine running NetDash or the router itself;
- verifies every write by re-reading the router's rule list;
- signs writes with the router's RSA key and the page's session token, the same
  `Check` header the web UI uses.

Tested against the **ZTE F670L** (F670 family). On that firmware, **Internet
blocking works** (the firewall MAC filter accepts writes and is verified). ZTE
disables **WLAN access-control editing** there: the page unbinds its rule Apply
button and the policy endpoint rejects POSTs, so the Wi-Fi switches stay locked.
That is a firmware restriction, not a NetDash choice.

![Blocking a device from the 3D map, with its detail panel open](netdash/docs/screen-03.png)

You can confirm both from **Settings → Test router control**: it writes and
removes a rule for a reserved MAC (`02:00:00:00:00:01`) and restores the router's
filter settings afterwards.

Other ZTE firmware may use different page names; those switches stay locked
instead of writing blindly.

If a switch stays locked, run `./linux-run.sh --diagnose` and inspect
`app/router-diagnostics.json`. It contains the raw access-control responses (no
passwords) needed to support another firmware variant.

ARP spoofing and Wi-Fi deauthentication would also work, but they are attacks
that break encryption assumptions and can knock devices off networks. NetDash
does not do that.

## Security

- The web server listens on `127.0.0.1` only.
- Every API call needs a random session token that is embedded in the page, and
  the `Host` header is validated. State-changing requests also validate
  `Origin`. This blocks DNS-rebinding and cross-site request forgery from other
  websites.
- Router credentials, if you choose to remember them, are stored in
  `~/.config/netdash/config.json` (`%APPDATA%\NetDash\config.json` on Windows)
  with `0600` permissions. They are never sent back to the browser.
- There is no outbound traffic except the router's local admin page.

## Platform notes

**Linux** uses `ip`, `ping`, `nmcli` and (optionally) `resolvectl`. These are
present on Linux Mint, Ubuntu and most desktop distributions.

**Windows** uses `ipconfig`, `arp -a`, `ping`, `netsh` and PowerShell for
per-interface counters. Run as Administrator for DNS changes. Windows Firewall
may prompt the first time Python listens on a port; NetDash only binds to
loopback, so you can deny the public-network prompt.

## Project layout

```
linux-run.sh               Linux launcher
windows-run.bat            Windows launcher
app/
  app.py                   entry point
  netdash/
    api.py                 application state + JSON API
    server.py              local HTTP server, token auth, static files
    netinfo.py             connection details (Linux + Windows)
    scanner.py             ping sweep, ARP table, vendor lookup
    dnsman.py              DNS profiles and apply/verify
    router/
      base.py              adapter interface
      zte.py               ZTE F-series adapter (login, client list)
    static/                HTML, CSS, vanilla JS
    data/oui.txt           IEEE OUI registry (offline vendor lookup)
    docs/                  screenshots used by this README
  build_pyz.sh             builds netdash.pyz from the sources
```

## Troubleshooting

**"Could not change DNS" / permission error** — run the app as root
(`sudo ./linux-run.sh`) or as Administrator on Windows.

**No devices appear** — some networks isolate clients (AP isolation). The scan
can only see hosts that answer ping or appear in the ARP table.

**Devices show as "phone" with no vendor** — modern phones use randomized,
locally administered MAC addresses, so the vendor cannot be resolved.

**Router login fails** — the address must be the gateway, and the username is
usually `admin`. Repeated wrong attempts make some ZTE routers lock logins for a
few minutes.
