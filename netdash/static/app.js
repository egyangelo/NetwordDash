(() => {
  "use strict";

  const token = document.querySelector('meta[name="netdash-token"]').content;
  const $ = (sel, root = document) => root.querySelector(sel);

  const ui = {
    hostname: $("#hostname"),
    adminPill: $("#admin-pill"),
    adminText: $("#admin-text"),
    ovSsid: $("#ov-ssid"),
    ovConnection: $("#ov-connection"),
    ovSignal: $("#ov-signal"),
    signalBars: $("#signal-bars"),
    signalText: $("#signal-text"),
    ovIp: $("#ov-ip"),
    ovMac: $("#ov-mac"),
    ovInterface: $("#ov-interface"),
    ovGateway: $("#ov-gateway"),
    ovRouterModel: $("#ov-router-model"),
    ovRouterHost: $("#ov-router-host"),
    ovDns: $("#ov-dns"),
    ovDnsServers: $("#ov-dns-servers"),
    ovDevicesCount: $("#ov-devices-count"),
    dnsGrid: $("#dns-grid"),
    dnsBadge: $("#dns-badge"),
    dnsHint: $("#dns-hint"),
    devicesSub: $("#devices-sub"),
    rows: $("#device-rows"),
    empty: $("#empty-state"),
    emptyText: $("#empty-text"),
    search: $("#search"),
    scanBtn: $("#scan-btn"),
    scanLabel: $("#scan-label"),
    accessNote: $("#access-note"),
    footVersion: $("#foot-version"),
    footPlatform: $("#foot-platform"),
    drawer: $("#drawer"),
    drawerBackdrop: $("#drawer-backdrop"),
    routerState: $("#router-state"),
    routerHost: $("#router-host"),
    routerUser: $("#router-user"),
    routerPass: $("#router-pass"),
    routerRemember: $("#router-remember"),
    routerConnect: $("#router-connect"),
    routerDisconnect: $("#router-disconnect"),
    routerDiag: $("#router-diag"),
    routerTest: $("#router-test"),
    routerCaps: $("#router-caps"),
    speedtest: $("#speedtest-btn"),
    speedPing: $("#speed-ping"),
    speedJitter: $("#speed-jitter"),
    speedDown: $("#speed-down"),
    speedUp: $("#speed-up"),
    speedFootNote: $("#speed-foot-note"),
    speedPhase: $("#speed-phase"),
    scanInterval: $("#scan-interval"),
    configPath: $("#config-path"),
    toasts: $("#toasts"),
    dialog: $("#confirm-dialog"),
    dialogTitle: $("#dialog-title"),
    dialogBody: $("#dialog-body"),
    dialogHint: $("#dialog-hint"),
    dialogOk: $("#dialog-ok"),
  };

  const state = {
    snapshot: null,
    devices: [],
    lastPayload: null,
    filter: "",
    busy: false,
    timer: null,
    dnsPending: false,
    pendingProfile: "",
    reloading: false,
    speedTimer: null,
    sort: { key: "address", dir: 1 },
  };

  // ---------------------------------------------------------------- helpers
  async function api(path, options = {}) {
    const init = {
      method: options.method || "GET",
      headers: { "X-Netdash-Token": token },
      cache: "no-store",
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (err) {
      throw new Error("Could not reach the NetDash server.");
    }
    if (response.status === 403) {
      // The server restarted and issued a new session token; a reload fixes it.
      if (!state.reloading) {
        state.reloading = true;
        toast("This tab is out of date after a server restart. Reloading…", "error");
        setTimeout(() => window.location.reload(), 1200);
      }
      const error = new Error("This dashboard tab is out of date.");
      error.stale = true;
      throw error;
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
    if (!response.ok) {
      const message = (payload && payload.error) || `Request failed (${response.status})`;
      const error = new Error(message);
      error.hint = (payload && payload.hint) || "";
      throw error;
    }
    return payload;
  }

  function toast(message, kind = "info", hint = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    const dot = document.createElement("span");
    dot.className = "toast-dot";
    const text = document.createElement("div");
    text.className = "toast-text";
    text.textContent = message;
    if (hint) {
      const sub = document.createElement("span");
      sub.className = "toast-hint";
      sub.textContent = hint;
      text.appendChild(sub);
    }
    node.append(dot, text);
    ui.toasts.appendChild(node);
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      setTimeout(() => node.remove(), 200);
    }, kind === "error" ? 7000 : 4200);
  }

  function confirmDialog(title, body, hint = "", okLabel = "Continue") {
    return new Promise((resolve) => {
      ui.dialogTitle.textContent = title;
      ui.dialogBody.textContent = body;
      ui.dialogHint.textContent = hint;
      ui.dialogHint.hidden = !hint;
      ui.dialogOk.textContent = okLabel;
      const onClose = () => {
        ui.dialog.removeEventListener("close", onClose);
        resolve(ui.dialog.returnValue === "ok");
      };
      ui.dialog.addEventListener("close", onClose);
      ui.dialog.returnValue = "cancel";
      ui.dialog.showModal();
    });
  }

  function fmtBytes(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = Number(value);
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function timeAgo(seconds) {
    if (!seconds) return "not yet";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    if (diff < 10) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------ icons
  const ICONS = {
    computer: '<rect x="2.5" y="4" width="19" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    tv: '<rect x="2.5" y="5" width="19" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    iot: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
    printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 17h12v4H6z"/>',
    console: '<path d="M6 8h4l2 3 2-3h4l2 5-2 5H8L6 13z"/><path d="M9 13h.01M15 13h.01"/>',
    router: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M10 16.5h.01M12 13V9M8 9a6 6 0 0 1 8 0"/>',
    other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 1.5"/>',
  };

  function deviceIcon(device) {
    if (device.is_gateway) return ICONS.router;
    if (device.is_self) return ICONS.computer;
    return ICONS[device.type] || ICONS.other;
  }

  function iconClass(device) {
    if (device.is_self) return "self";
    if (device.is_gateway) return "gateway";
    return ["phone", "computer", "tv", "iot", "printer", "console", "router"].includes(device.type)
      ? device.type
      : "";
  }

  function signalLevel(percent) {
    if (percent === null || percent === undefined) return 0;
    if (percent >= 80) return 4;
    if (percent >= 60) return 3;
    if (percent >= 35) return 2;
    if (percent >= 15) return 1;
    return 0;
  }

  // ------------------------------------------------------------- render state
  function renderState(snapshot) {
    state.snapshot = snapshot;
    const net = snapshot.network || {};
    const dns = snapshot.dns || {};
    const router = snapshot.router || {};

    ui.hostname.textContent = snapshot.hostname
      ? `${snapshot.hostname} · ${net.interface || "network"}`
      : "Local network overview";

    ui.adminPill.hidden = !snapshot.admin;
    ui.adminPill.classList.toggle("admin", !!snapshot.admin);
    ui.adminText.textContent = "Administrator";

    const ssid = net.ssid || (net.connection && net.connection !== "" ? net.connection : "Wired network");
    ui.ovSsid.textContent = ssid || "—";
    const bits = [];
    if (net.security) bits.push(net.security.toUpperCase());
    if (net.link_mbps) bits.push(`${Math.round(net.link_mbps)} Mbps`);
    if (net.frequency_mhz) bits.push(`${(net.frequency_mhz / 1000).toFixed(1)} GHz`);
    ui.ovConnection.textContent = bits.join(" · ") || (net.interface ? "Connected" : "Offline");

    const signal = net.signal !== null && net.signal !== undefined
      ? net.signal
      : net.signal_dbm !== undefined && net.signal_dbm !== null
        ? Math.max(0, Math.min(100, 2 * (net.signal_dbm + 100)))
        : null;
    if (signal !== null && signal !== undefined) {
      ui.ovSignal.hidden = false;
      const level = signalLevel(signal);
      ui.signalBars.innerHTML = "";
      for (let i = 1; i <= 4; i += 1) {
        const bar = document.createElement("i");
        if (i <= level) bar.className = "on";
        ui.signalBars.appendChild(bar);
      }
      ui.signalText.textContent = net.signal_dbm
        ? `${net.signal_dbm} dBm`
        : `${Math.round(signal)}% signal`;
    } else {
      ui.ovSignal.hidden = true;
    }

    ui.ovIp.textContent = net.ip ? `${net.ip}${net.prefix ? `/${net.prefix}` : ""}` : "—";
    ui.ovMac.textContent = net.mac || "No MAC address";
    const traffic = [];
    if (net.rx_bytes !== undefined) traffic.push(`↓ ${fmtBytes(net.rx_bytes)}`);
    if (net.tx_bytes !== undefined) traffic.push(`↑ ${fmtBytes(net.tx_bytes)}`);
    ui.ovInterface.textContent = traffic.length ? traffic.join("   ") : (net.interface || "—");

    ui.ovGateway.textContent = net.gateway || "—";
    ui.ovRouterModel.textContent = router.connected
      ? `${router.model || "Router"} · connected`
      : "Router not connected";
    ui.ovRouterHost.textContent = router.host ? `${router.host}` : "";

    const profile = (dns.profiles && dns.profiles[dns.profile]) || null;
    ui.ovDns.textContent = profile ? profile.label : dns.profile === "custom" ? "Custom DNS" : "—";
    ui.ovDnsServers.textContent = (dns.servers || []).join(", ") || "From DHCP";
    ui.ovDevicesCount.textContent = `${state.devices.length} device${state.devices.length === 1 ? "" : "s"} seen`;

    ui.footVersion.textContent = `NetDash ${snapshot.version || ""}`.trim();
    ui.footPlatform.textContent = `${snapshot.platform === "windows" ? "Windows" : "Linux"} · localhost only`;

    renderDns(dns);
    renderRouter(router);
  }

  function renderDns(dns) {
    if (!dns || !dns.profiles) return;
    ui.dnsGrid.innerHTML = "";
    const order = [
      "none", "google", "familyshield", "adguard",
      "cloudflare-malware", "cloudflare-family",
    ];
    const keys = Object.keys(dns.profiles).sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    const pending = !!state.dnsPending;
    for (const key of keys) {
      const profile = dns.profiles[key];
      const isPending = pending && state.pendingProfile === key;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dns-card"
        + (dns.profile === key ? " selected" : "")
        + (isPending ? " pending" : "");
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", dns.profile === key ? "true" : "false");
      button.disabled = pending;
      button.dataset.profile = key;
      const marker = isPending ? '<span class="spinner tiny"></span>' : '<span class="dns-check"></span>';
      const servers = isPending
        ? "Applying…"
        : (profile.servers.length ? profile.servers.join(" · ") : "From router");
      button.innerHTML = `
        <span class="dns-name">${escapeHtml(profile.label)}${marker}</span>
        <span class="dns-servers">${escapeHtml(servers)}</span>
        <span class="dns-hint">${escapeHtml(profile.hint)}</span>`;
      button.addEventListener("click", () => chooseDns(key));
      ui.dnsGrid.appendChild(button);
    }

    if (pending) {
      ui.dnsBadge.innerHTML = '<span class="spinner tiny"></span>Applying…';
      ui.dnsBadge.className = "badge pending";
    } else {
      const current = dns.profile === "custom"
        ? "Custom DNS"
        : (dns.profiles[dns.profile] && dns.profiles[dns.profile].label) || "Unknown";
      ui.dnsBadge.textContent = `${current} active`;
      ui.dnsBadge.className = "badge" + (dns.profile !== "none" ? " active" : "");
    }

    ui.dnsHint.textContent =
      "The active connection is re-applied after a change, so expect a brief pause. " +
      "If the system refuses it, start NetDash with administrator rights.";
    ui.dnsHint.className = "hint-line";
  }

  function renderRouter(router) {
    const caps = router.capabilities || {};
    ui.routerState.textContent = router.connected
      ? `Connected to ${router.model || "router"} at ${router.host}.`
      : "Not connected.";
    ui.routerDisconnect.hidden = !router.connected;
    ui.routerDiag.hidden = !router.connected;
    ui.routerTest.hidden = !router.connected;
    ui.routerConnect.textContent = router.connected ? "Reconnect" : "Connect";

    const notes = [];
    if (router.connected) {
      if (caps.devices) notes.push("Device list is read from the router.");
      if (caps.block) {
        notes.push("Internet blocking uses the router's firewall MAC filter (routed traffic only).");
      } else {
        notes.push("Per-device Internet blocking is unavailable.");
      }
      if (caps.wifi) {
        notes.push("Wi-Fi blocking uses the router's WLAN access control for the device's SSID.");
      } else {
        notes.push("Per-device Wi-Fi blocking is unavailable.");
      }
      for (const note of caps.notes || []) if (!notes.includes(note)) notes.push(note);
    }
    ui.routerCaps.textContent = notes.join(" ");

    const canControl = !!router.connected && !!caps.block;
    const canWifi = !!router.connected && !!caps.wifi;
    const note = $("#access-note");
    if (!router.connected) {
      note.innerHTML =
        'Router control is off. Connect your router in <a href="#" id="open-settings-inline">Settings</a> to read its device list and manage access.';
      const link = $("#open-settings-inline");
      if (link) link.addEventListener("click", (event) => { event.preventDefault(); openDrawer(); });
    } else if (!canControl) {
      note.innerHTML =
        "Router access-control data could not be read, so the switches stay locked. " +
        `<a href="https://${escapeHtml(router.host || "192.168.1.1")}/" target="_blank" rel="noopener noreferrer">Open the router admin page</a> to block a device.`;
    } else {
      note.textContent = canWifi
        ? "Toggles write a rule on the router immediately. Internet rules survive reboots; Wi-Fi rules are per SSID."
        : "Internet blocking is active; Wi-Fi blocking is unavailable on this firmware.";
    }

    for (const row of ui.rows.querySelectorAll("tr[data-mac]")) {
      const internet = row.querySelector(".toggle-internet input");
      const wifi = row.querySelector(".toggle-wifi input");
      if (internet) internet.disabled = !canControl;
      if (wifi) wifi.disabled = !canWifi || row.dataset.connection === "lan";
    }
  }

  // ------------------------------------------------------------ render devices
  function ipNumber(ip) {
    const parts = String(ip || "").split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
      return Number.MAX_SAFE_INTEGER;
    }
    return parts.reduce((total, part) => total * 256 + Number(part), 0);
  }

  function sortValue(device, key) {
    switch (key) {
      case "device": return (device.name || device.vendor || "Unknown device").toLowerCase();
      case "address": return ipNumber(device.ip);
      case "type": return (device.type || "").toLowerCase();
      case "status": return device.online ? 0 : 1;
      default: return 0;
    }
  }

  function sortDevices(devices) {
    const { key, dir } = state.sort;
    return [...devices].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      const ai = ipNumber(a.ip);
      const bi = ipNumber(b.ip);
      if (ai !== bi) return ai - bi;
      return String(a.mac || "").localeCompare(String(b.mac || ""));
    });
  }

  function renderSortButtons() {
    for (const button of document.querySelectorAll(".sort-btn")) {
      const active = button.dataset.sort === state.sort.key;
      button.classList.toggle("active", active);
      button.classList.toggle("asc", active && state.sort.dir === 1);
      button.classList.toggle("desc", active && state.sort.dir === -1);
    }
  }

  function renderDevices(payload) {
    if (payload.scanned_at !== undefined) state.lastPayload = payload;
    state.devices = payload.devices || [];
    const router = (state.snapshot && state.snapshot.router) || {};
    const caps = router.capabilities || {};
    const canControl = !!router.connected && !!caps.block;
    const canWifi = !!router.connected && !!caps.wifi;

    const filter = state.filter.trim().toLowerCase();
    const filtered = state.devices.filter((device) => {
      if (!filter) return true;
      return [device.label, device.name, device.vendor, device.ip, device.mac, device.type, device.ssid]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(filter));
    });
    const visible = sortDevices(filtered);

    ui.rows.innerHTML = "";
    for (const device of visible) ui.rows.appendChild(deviceRow(device, canControl, canWifi));

    const total = state.devices.length;
    const online = state.devices.filter((d) => d.online).length;
    ui.ovDevicesCount.textContent = `${total} device${total === 1 ? "" : "s"} seen`;
    const subnet = payload.subnet ? ` · ${payload.subnet}` : "";
    ui.devicesSub.textContent =
      `${online} online · ${total} seen · scanned ${timeAgo(payload.scanned_at)}${subnet}`;

    const showEmpty = visible.length === 0;
    ui.empty.hidden = !showEmpty;
    ui.emptyText.textContent = total === 0
      ? (payload.scanning ? "Scanning the network…" : "No devices found. Try scanning again.")
      : "No devices match your filter.";
  }

  function deviceRow(device, canControl, canWifi) {
    const row = document.createElement("tr");
    if (!device.online) row.classList.add("offline");
    row.dataset.mac = device.mac || "";
    row.dataset.connection = device.connection || "";

    const name = device.name || device.vendor || "Unknown device";
    const tags = [];
    if (device.label) {
      tags.push(`<span class="tag label" title="Custom label">${escapeHtml(device.label)}</span>`);
    }
    if (device.is_self) tags.push('<span class="tag you">You</span>');
    if (device.is_gateway) tags.push('<span class="tag router">Router</span>');
    if (device.blocked) tags.push('<span class="tag blocked">Blocked</span>');
    const sub = [device.vendor && device.vendor !== name ? device.vendor : "", device.ssid || ""]
      .filter(Boolean)
      .join(" · ");

    const nameCell = document.createElement("td");
    nameCell.innerHTML = `
      <div class="device-cell">
        <span class="device-icon ${iconClass(device)}"><svg viewBox="0 0 24 24" aria-hidden="true">${deviceIcon(device)}</svg></span>
        <div class="device-main">
          <div class="device-name">
            <span class="name-text">${escapeHtml(name)}</span>
            <button class="label-edit" type="button" title="${device.label ? "Edit label" : "Add label"}" aria-label="Edit label">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            </button>
            ${tags.join("")}
          </div>
          <div class="device-sub">${escapeHtml(sub || (device.random_mac ? "Private Wi-Fi address" : "—"))}</div>
        </div>
      </div>`;

    nameCell.querySelector(".label-edit").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      editLabel(nameCell, device);
    });

    const addressCell = document.createElement("td");
    addressCell.innerHTML = `
      <div class="addr-ip">${escapeHtml(device.ip || "—")}</div>
      <div class="addr-mac">${escapeHtml(device.mac || "no MAC")}</div>`;

    const typeCell = document.createElement("td");
    const TYPE_LABELS = {
      phone: "Phone", computer: "Computer", tv: "TV", iot: "IoT",
      printer: "Printer", console: "Console", router: "Router", other: "Other",
    };
    typeCell.innerHTML = `<span class="type-chip">${escapeHtml(TYPE_LABELS[device.type] || "Other")}</span>`;

    const statusCell = document.createElement("td");
    let statusText = "Offline";
    let statusClass = "offline";
    if (device.online) {
      statusText = device.state === "router" ? "On router" : "Online";
      statusClass = "online";
    } else if (device.responded === false) {
      statusText = "Last seen";
    }
    statusCell.innerHTML = `<span class="status ${statusClass}"><i></i>${statusText}</span>`;

    const wifiDevice = device.connection !== "lan";
    const wifiEnabled = canWifi && wifiDevice;

    const internetCell = document.createElement("td");
    internetCell.className = "center toggle-cell";
    internetCell.innerHTML = switchMarkup(
      "toggle-internet", device.mac, !device.blocked, canControl,
      canControl
        ? (device.blocked ? "Blocked on the router - click to allow" : "Allowed - click to block")
        : "Router access control is not available"
    );

    const wifiCell = document.createElement("td");
    wifiCell.className = "center toggle-cell";
    wifiCell.innerHTML = switchMarkup(
      "toggle-wifi", device.mac, !device.wifi_blocked, wifiEnabled,
      !canWifi
        ? "This router has no per-device Wi-Fi switch"
        : (!wifiDevice ? "This device is connected by Ethernet"
          : (device.wifi_blocked ? "Wi-Fi blocked - click to allow" : "Wi-Fi allowed - click to block"))
    );

    row.append(nameCell, addressCell, typeCell, statusCell, internetCell, wifiCell);

    const internetInput = row.querySelector(".toggle-internet input");
    internetInput.addEventListener("change", () => setAccess(device, "internet", internetInput));
    const wifiInput = row.querySelector(".toggle-wifi input");
    wifiInput.addEventListener("change", () => setAccess(device, "wifi", wifiInput));

    for (const cell of [internetCell, wifiCell]) {
      cell.addEventListener("click", (event) => {
        const input = cell.querySelector("input");
        if (input && input.disabled) {
          event.preventDefault();
          explainAccess(device);
        }
      });
    }
    return row;
  }

  function editLabel(cell, device) {
    const main = cell.querySelector(".device-main");
    const pencil = cell.querySelector(".label-edit");
    if (!main || main.querySelector(".label-input")) return;
    const current = device.label || "";
    const input = document.createElement("input");
    input.className = "label-input";
    input.type = "text";
    input.maxLength = 48;
    input.placeholder = "Label (empty to clear)";
    input.value = current;
    main.insertBefore(input, main.querySelector(".device-sub"));
    if (pencil) pencil.style.visibility = "hidden";
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (!save || value === current) {
        renderDevices(state.lastPayload || { devices: state.devices });
        return;
      }
      try {
        const result = await api("/api/device/label", {
          method: "POST",
          body: { mac: device.mac, label: value },
        });
        device.label = result.label || "";
        toast(device.label ? `Label saved for ${device.mac}.` : "Label cleared.", "ok");
      } catch (error) {
        toast(error.message || "Could not save the label.", "error", error.hint || "");
      }
      renderDevices(state.lastPayload || { devices: state.devices });
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function switchMarkup(cls, mac, checked, enabled, title) {
    return `<label class="switch ${cls}" title="${escapeHtml(title)}">
      <input type="checkbox" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"}
             aria-label="${escapeHtml(title)}" data-mac="${escapeHtml(mac || "")}">
      <span class="track"></span>
    </label>`;
  }

  async function explainAccess(device) {
    const router = (state.snapshot && state.snapshot.router) || {};
    const caps = router.capabilities || {};
    if (!router.connected) {
      const go = await confirmDialog(
        "Router not connected",
        "Per-device access control lives on the router. Sign in to the router to enable these switches.",
        "You can also block the device from the router's own admin page.",
        "Open settings"
      );
      if (go) openDrawer();
      return;
    }
    if (!caps.block) {
      await confirmDialog(
        "Not available on this firmware",
        "The router's access-control pages could not be read, so NetDash will not write to them.",
        `Open https://${router.host || "192.168.1.1"}/ and use Access Control / MAC Filter.`,
        "Close"
      );
      return;
    }
    if (device.connection === "lan") {
      await confirmDialog(
        "Wired device",
        "This device is connected by Ethernet, so a Wi-Fi rule would not affect it.",
        "Use the Internet switch to block it, or unplug it.",
        "Close"
      );
      return;
    }
    if (!caps.wifi) {
      const reason = (caps.notes || []).find((n) => n.toLowerCase().includes("wi-fi"))
        || "The router does not expose a per-device Wi-Fi switch.";
      await confirmDialog(
        "Wi-Fi control unavailable",
        reason,
        "Internet blocking still works through the firewall MAC filter.",
        "Close"
      );
    }
  }

  // -------------------------------------------------------------- speed test
  function formatMbps(value) {
    if (value === null || value === undefined) return "—";
    return value >= 100 ? String(Math.round(value)) : Number(value).toFixed(1);
  }

  function renderSpeed(status) {
    const result = status.result || {};
    const running = !!status.running;
    ui.speedtest.disabled = running;
    ui.speedtest.textContent = running ? "Testing…" : "Run speed test";
    ui.speedPing.textContent = result.ping_ms != null ? String(Math.round(result.ping_ms)) : "—";
    ui.speedJitter.textContent = result.jitter_ms != null ? `± ${Math.round(result.jitter_ms)} ms jitter` : "";
    ui.speedDown.textContent = formatMbps(result.download_mbps);
    ui.speedUp.textContent = formatMbps(result.upload_mbps);
    ui.speedFootNote.textContent = result.tested_at ? `Last test ${timeAgo(result.tested_at)}` : "";
    for (const card of document.querySelectorAll(".speed-card")) {
      card.classList.toggle("running", running);
    }

    if (running) {
      const phases = {
        latency: "Measuring latency…",
        download: "Measuring download speed…",
        upload: "Measuring upload speed…",
      };
      ui.speedPhase.innerHTML = '<span class="spinner tiny"></span>' + (phases[status.phase] || "Testing…");
      ui.speedPhase.className = "hint-line";
    } else if (status.error) {
      ui.speedPhase.textContent = `Speed test failed: ${status.error}`;
      ui.speedPhase.className = "hint-line warn";
    } else if (result.tested_at) {
      ui.speedPhase.textContent = `Server ${result.server || "Cloudflare"} · tested ${timeAgo(result.tested_at)}`;
      ui.speedPhase.className = "hint-line";
    } else {
      ui.speedPhase.textContent = "Not tested yet.";
      ui.speedPhase.className = "hint-line";
    }
  }

  async function pollSpeedOnce() {
    try {
      const status = await api("/api/speedtest/status");
      renderSpeed(status);
      if (status.running) scheduleSpeedPoll();
    } catch (error) {
      /* a failed background poll is not worth a toast */
    }
  }

  function scheduleSpeedPoll() {
    if (state.speedTimer) return;
    state.speedTimer = setTimeout(() => {
      state.speedTimer = null;
      pollSpeedOnce();
    }, 700);
  }

  async function runSpeedTest() {
    if (ui.speedtest.disabled) return;
    ui.speedtest.disabled = true;
    ui.speedtest.textContent = "Testing…";
    try {
      await api("/api/speedtest/start", { method: "POST", body: {} });
    } catch (error) {
      ui.speedtest.disabled = false;
      ui.speedtest.textContent = "Run speed test";
      toast(error.message || "Could not start the speed test.", "error", error.hint || "");
      return;
    }
    pollSpeedOnce();
  }

  // ------------------------------------------------------------------ actions
  async function chooseDns(key) {
    if (!state.snapshot || state.dnsPending) return;
    const dns = state.snapshot.dns || {};
    if (dns.profile === key) return;
    const profile = (dns.profiles || {})[key];
    if (!profile) return;

    const ok = await confirmDialog(
      `Switch DNS to ${profile.label}?`,
      profile.servers.length
        ? `This sets ${profile.servers.join(", ")} for this computer.`
        : "This clears the manual DNS servers and uses whatever the router provides.",
      "The connection is re-applied and may drop for a second.",
      "Switch DNS"
    );
    if (!ok) return;

    state.dnsPending = true;
    state.pendingProfile = key;
    renderDns(dns);
    try {
      await api("/api/dns", { method: "POST", body: { profile: key } });
    } catch (error) {
      state.dnsPending = false;
      state.pendingProfile = "";
      renderDns(dns);
      toast(error.message || "Could not change DNS.", "error", error.hint || "");
      return;
    }
    state.dnsPending = false;
    state.pendingProfile = "";
    toast(`DNS switched to ${profile.label}.`, "ok");
    try {
      await refreshState();
    } catch (error) {
      renderDns(dns);
    }
  }

  async function setAccess(device, scope, input) {
    const label = scope === "wifi" ? "Wi-Fi access" : "Internet access";
    const allowed = input.checked;
    const who = device.name || device.ip;

    if (!allowed) {
      const ok = await confirmDialog(
        `Block ${who}?`,
        scope === "wifi"
          ? "This adds a rule to the router's WLAN access control for this device's SSID."
          : "This adds a rule to the router's firewall MAC filter. The MAC filter is switched on if it was off.",
        "You can undo it by switching the toggle back on at any time.",
        "Block"
      );
      if (!ok) {
        input.checked = true;
        return;
      }
    }

    const cell = input.closest("td.toggle-cell");
    input.disabled = true;
    if (cell) cell.classList.add("busy");
    try {
      const result = await api("/api/device/access", {
        method: "POST",
        body: { mac: device.mac, scope, allowed },
      });
      if (result && result.verified === false) {
        toast(result.message || "The router did not confirm the change.", "error",
          "Open the router's access-control page to check the rule.");
      } else {
        toast(result.message || `${label} ${allowed ? "allowed" : "blocked"} for ${device.name || device.ip}.`, "ok");
      }
      await refreshState();
      await refreshDevices(false);
    } catch (error) {
      input.checked = !allowed;
      toast(error.message || "Could not change device access.", "error", error.hint || "");
    } finally {
      if (cell && cell.isConnected) {
        cell.classList.remove("busy");
        input.disabled = false;
      }
    }
  }

  async function refreshState() {
    const snapshot = await api("/api/state");
    renderState(snapshot);
    return snapshot;
  }

  async function refreshDevices(force = false) {
    if (force) setScanning(true);
    try {
      const payload = await api(`/api/devices${force ? "?refresh=1" : ""}`);
      renderDevices(payload);
      return payload;
    } finally {
      setScanning(false);
    }
  }

  function setScanning(active) {
    ui.scanBtn.disabled = active;
    ui.scanLabel.textContent = active ? "Scanning…" : "Scan now";
  }

  async function doScan() {
    if (state.busy) return;
    state.busy = true;
    setScanning(true);
    ui.devicesSub.textContent = "Scanning the local network…";
    try {
      const payload = await api("/api/devices/scan", { method: "POST", body: {} });
      renderDevices(payload);
      await refreshState();
      toast("Scan finished.", "ok");
    } catch (error) {
      toast(error.message || "Scan failed.", "error", error.hint || "");
    } finally {
      state.busy = false;
      setScanning(false);
    }
  }

  // ----------------------------------------------------------------- settings
  function openDrawer() {
    ui.drawer.hidden = false;
    ui.drawerBackdrop.hidden = false;
    ui.drawer.setAttribute("aria-hidden", "false");
    loadSettings();
  }

  function closeDrawer() {
    ui.drawer.hidden = true;
    ui.drawerBackdrop.hidden = true;
    ui.drawer.setAttribute("aria-hidden", "true");
  }

  async function loadSettings() {
    try {
      const settings = await api("/api/settings");
      const router = settings.router || {};
      if (!ui.routerHost.value) {
        ui.routerHost.value = router.host ||
          (state.snapshot && state.snapshot.network && state.snapshot.network.gateway) || "";
      }
      if (!ui.routerUser.value) ui.routerUser.value = router.username || "admin";
      ui.routerRemember.checked = router.remember !== false;
      ui.scanInterval.value = (settings.scan && settings.scan.autorefresh_seconds) || 45;
      ui.configPath.textContent = settings.config_path || "";
    } catch (error) {
      toast(error.message || "Could not load settings.", "error");
    }
  }

  async function connectRouter() {
    const host = ui.routerHost.value.trim();
    const username = ui.routerUser.value.trim();
    const password = ui.routerPass.value;
    ui.routerConnect.disabled = true;
    ui.routerConnect.textContent = "Connecting…";
    try {
      const info = await api("/api/router/login", {
        method: "POST",
        body: { host, username, password, remember: ui.routerRemember.checked },
      });
      ui.routerPass.value = "";
      toast(`Connected to ${info.model || "router"}.`, "ok");
      await refreshState();
      await refreshDevices(false);
      loadSettings();
    } catch (error) {
      toast(error.message || "Could not connect to the router.", "error", error.hint || "");
    } finally {
      ui.routerConnect.disabled = false;
      ui.routerConnect.textContent = (state.snapshot && state.snapshot.router && state.snapshot.router.connected)
        ? "Reconnect" : "Connect";
    }
  }

  async function disconnectRouter() {
    try {
      await api("/api/router/logout", { method: "POST", body: {} });
      toast("Router disconnected.", "ok");
      await refreshState();
      await refreshDevices(false);
    } catch (error) {
      toast(error.message || "Could not disconnect.", "error");
    }
  }

  async function testRouterControl() {
    ui.routerTest.disabled = true;
    ui.routerTest.textContent = "Testing…";
    try {
      const result = await api("/api/router/selftest", { method: "POST", body: {} });
      const internet = result.internet || {};
      const wifi = result.wifi || {};
      const ok = !!internet.ok && !!wifi.ok;
      const details = [
        `Internet: ${internet.ok ? "ok" : "failed"} — ${internet.message || ""}`,
        `Wi-Fi: ${wifi.ok ? "ok" : "failed"} — ${wifi.message || ""}`,
        result.restored ? "Router settings restored." : "",
        (result.errors || []).length ? `Errors: ${result.errors.join("; ")}` : "",
      ].filter(Boolean).join(" ");
      toast(ok ? "Router control works." : "Router control test reported a problem.",
        ok ? "ok" : "error", details);
    } catch (error) {
      toast(error.message || "Router control test failed.", "error", error.hint || "");
    } finally {
      ui.routerTest.disabled = false;
      ui.routerTest.textContent = "Test router control";
    }
  }

  async function downloadDiagnostics() {
    try {
      const data = await api("/api/router/diagnostics");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "netdash-router-diagnostics.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Diagnostics saved.", "ok");
    } catch (error) {
      toast(error.message || "Could not read router diagnostics.", "error", error.hint || "");
    }
  }

  async function saveSettings() {
    try {
      await api("/api/settings", {
        method: "POST",
        body: {
          router: {
            host: ui.routerHost.value.trim(),
            username: ui.routerUser.value.trim(),
            remember: ui.routerRemember.checked,
          },
          scan: { autorefresh_seconds: Number(ui.scanInterval.value) || 45 },
        },
      });
      toast("Settings saved.", "ok");
      await refreshState();
      scheduleRefresh();
    } catch (error) {
      toast(error.message || "Could not save settings.", "error");
    }
  }

  // -------------------------------------------------------------------- boot
  function scheduleRefresh() {
    if (state.timer) clearTimeout(state.timer);
    const seconds = (state.snapshot && state.snapshot.scan && state.snapshot.scan.autorefresh_seconds) || 45;
    state.timer = setTimeout(async () => {
      if (!document.hidden) {
        try {
          await refreshState();
          await refreshDevices(false);
        } catch (error) {
          /* a failed background refresh is not worth a toast */
        }
      }
      scheduleRefresh();
    }, Math.max(15, seconds) * 1000);
  }

  async function boot() {
    try {
      await refreshState();
    } catch (error) {
      toast(error.message || "Could not load NetDash.", "error");
      return;
    }
    ui.routerHost.placeholder = (state.snapshot.network && state.snapshot.network.gateway) || "192.168.1.1";
    try {
      await refreshDevices(false);
    } catch (error) {
      toast(error.message || "Could not scan the network.", "error", error.hint || "");
    }
    scheduleRefresh();
    pollSpeedOnce();
  }

  $("#refresh-btn").addEventListener("click", async () => {
    try {
      await refreshState();
      await refreshDevices(false);
      toast("Refreshed.", "ok");
    } catch (error) {
      toast(error.message || "Refresh failed.", "error");
    }
  });
  $("#scan-btn").addEventListener("click", doScan);
  ui.speedtest.addEventListener("click", runSpeedTest);
  $("#settings-btn").addEventListener("click", openDrawer);
  $("#drawer-close").addEventListener("click", closeDrawer);
  ui.drawerBackdrop.addEventListener("click", closeDrawer);
  ui.routerConnect.addEventListener("click", connectRouter);
  ui.routerDisconnect.addEventListener("click", disconnectRouter);
  ui.routerDiag.addEventListener("click", downloadDiagnostics);
  ui.routerTest.addEventListener("click", testRouterControl);
  $("#save-settings").addEventListener("click", saveSettings);
  ui.search.addEventListener("input", () => {
    state.filter = ui.search.value;
    renderDevices(state.lastPayload || { devices: state.devices, scanned_at: 0, subnet: "" });
  });

  for (const button of document.querySelectorAll(".sort-btn")) {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir *= -1;
      } else {
        state.sort = { key, dir: 1 };
      }
      renderSortButtons();
      renderDevices(state.lastPayload || { devices: state.devices, scanned_at: 0, subnet: "" });
    });
  }
  renderSortButtons();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.drawer.hidden) closeDrawer();
  });

  boot();
})();
