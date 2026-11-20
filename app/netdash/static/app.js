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
    showMac: $("#show-mac"),
    configPath: $("#config-path"),
    toasts: $("#toasts"),
    dialog: $("#confirm-dialog"),
    dialogTitle: $("#dialog-title"),
    dialogBody: $("#dialog-body"),
    dialogHint: $("#dialog-hint"),
    dialogOk: $("#dialog-ok"),
    viewDashboard: $("#view-dashboard"),
    view3d: $("#view-3d"),
    viewTabs: document.querySelectorAll(".view-tab"),
    sceneCanvas: $("#scene3d"),
    sceneShell: $("#scene-shell"),
    sceneTip: $("#scene-tip"),
    sceneEmpty: $("#scene-empty"),
    sceneEmptyText: $("#scene-empty-text"),
    sceneOnline: $("#scene-online"),
    sceneOffline: $("#scene-offline"),
    sceneBlocked: $("#scene-blocked"),
    sceneRouterStat: $("#scene-router-stat"),
    sceneRouterText: $("#scene-router-text"),
    sceneRotate: $("#scene-rotate"),
    sceneHideOffline: $("#scene-hide-offline"),
    sceneFullscreen: $("#scene-fullscreen"),
    sceneLegend: $("#scene-legend"),
    legendItems: document.querySelectorAll(".legend-item"),
    legendClear: $("#legend-clear"),
    appearanceButtons: document.querySelectorAll(".appearance-btn"),
    nodePanel: $("#node-panel"),
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
    view: "dashboard",
    scene: null,
    selectedKey: "",
    panelKey: "",
    panelEditing: false,
    hideOffline: false,
    focusTypes: [],
    devicesLoaded: false,
    showMac: true,
    theme: "dark",
    themeMode: "auto",
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

  const MAC_MASK = "••:••:••:••:••:••";

  // A MAC address identifies one physical device, so it is masked unless the
  // user opts in. Masked values keep the same width as the real address and
  // reveal on hover, tap or keyboard focus, so they stay usable on demand.
  function macMarkup(mac, fallback = "—") {
    const value = String(mac || "").trim();
    if (!value) return escapeHtml(fallback);
    if (state.showMac) return escapeHtml(value);
    return `<span class="mac-value masked" tabindex="0" role="button" aria-pressed="false" aria-label="Show MAC address" title="Show MAC address"><span class="mac-real">${escapeHtml(value)}</span><span class="mac-mask" aria-hidden="true">${MAC_MASK}</span></span>`;
  }

  // Text-only variant for toasts, which use textContent.
  function macText(mac) {
    const value = String(mac || "").trim();
    if (!value) return "";
    return state.showMac ? value : MAC_MASK;
  }

  function toggleMacReveal(node) {
    const revealed = node.classList.toggle("is-revealed");
    const label = revealed ? "Hide MAC address" : "Show MAC address";
    node.setAttribute("aria-pressed", revealed ? "true" : "false");
    node.setAttribute("aria-label", label);
    node.title = label;
  }

  function applyShowMac(show, options = {}) {
    const { persist = true } = options;
    state.showMac = !!show;
    if (ui.showMac) ui.showMac.checked = state.showMac;
    if (persist) {
      try {
        localStorage.setItem("netdash-show-mac", state.showMac ? "1" : "0");
      } catch (error) {
        /* private mode: remembering the choice is optional */
      }
    }
    const net = (state.snapshot && state.snapshot.network) || {};
    ui.ovMac.innerHTML = macMarkup(net.mac, "No MAC address");
    renderDevices(state.lastPayload || { devices: state.devices, scanned_at: 0, subnet: "" });
    refreshNodePanel();
  }

  // ------------------------------------------------------------------ icons
  const TYPE_LABELS = {
    phone: "Phone", tablet: "Tablet", computer: "Desktop PC", laptop: "Laptop",
    tv: "TV", camera: "Camera", light: "Smart light", speaker: "Speaker",
    xbox: "Xbox", playstation: "PlayStation", console: "Console",
    printer: "Printer", router: "Router", iot: "IoT", other: "Other",
  };

  const TYPE_ORDER = [
    "computer", "laptop", "tablet", "phone", "tv", "camera", "light",
    "speaker", "xbox", "playstation", "console", "printer", "iot",
    "router", "other",
  ];

  function typeSelectMarkup(device) {
    const autoType = device.auto_type || device.type || "other";
    const current = device.type_override || "auto";
    const title = device.type_override
      ? "Manual override. Choose Auto to restore automatic detection."
      : "Detected automatically. Pick a category to override it.";
    const options = [
      `<option value="auto"${current === "auto" ? " selected" : ""}>Auto · ${escapeHtml(TYPE_LABELS[autoType] || "Other")}</option>`,
      ...TYPE_ORDER.map((type) => (
        `<option value="${type}"${current === type ? " selected" : ""}>${escapeHtml(TYPE_LABELS[type] || type)}</option>`
      )),
    ];
    const manual = device.type_override
      ? '<span class="tag manual">Manual</span>'
      : "";
    return `<span class="type-edit-wrap">
      <span class="type-select-box">
        <select class="type-select" title="${escapeHtml(title)}" aria-label="Device type">${options.join("")}</select>
        <svg class="type-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </span>
      ${manual}
    </span>`;
  }

  const ICONS = {
    computer: '<rect x="2.5" y="5" width="12" height="9" rx="1.5"/><path d="M8.5 20h4M10.5 14v6"/><rect x="17" y="8" width="4.5" height="12" rx="1"/>',
    laptop: '<rect x="4" y="4" width="16" height="10" rx="1.5"/><path d="M2 19h20l-2-3H4z"/>',
    tablet: '<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    tv: '<rect x="2.5" y="5" width="19" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    camera: '<path d="M4 13a8 8 0 0 1 16 0z"/><circle cx="12" cy="15.5" r="2"/><path d="M5 19h14"/>',
    light: '<path d="M9.5 17h5M10.5 20h3M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    speaker: '<rect x="6" y="3" width="12" height="18" rx="5"/><circle cx="12" cy="8.5" r="1.6"/><circle cx="12" cy="15.5" r="1.2"/>',
    xbox: '<circle cx="12" cy="12" r="8"/><path d="m8.8 8.8 6.4 6.4M15.2 8.8l-6.4 6.4"/>',
    playstation: '<path d="M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 13H9l-1.6 1.8A3 3 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M6 12h2M7 11v2M16 11.5h.01M18 13.5h.01"/>',
    console: '<path d="M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 13H9l-1.6 1.8A3 3 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M6 12h2M7 11v2M16 11.5h.01M18 13.5h.01"/>',
    iot: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
    printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 17h12v4H6z"/>',
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
    return ["phone", "tablet", "computer", "laptop", "tv", "camera", "light", "speaker",
      "xbox", "playstation", "console", "printer", "router", "iot"].includes(device.type)
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
    ui.ovMac.innerHTML = macMarkup(net.mac, "No MAC address");
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
    syncScene();
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
      "Changes re-apply the connection, so expect a brief pause. " +
      "Administrator rights may be required.";
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
    state.devicesLoaded = true;
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

    syncScene();
    refreshNodePanel();
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
      <div class="addr-mac">${macMarkup(device.mac, "no MAC")}</div>`;

    const typeCell = document.createElement("td");
    if (device.is_gateway || !device.mac) {
      typeCell.innerHTML = `<span class="type-chip">${escapeHtml(TYPE_LABELS[device.type] || "Other")}</span>`;
    } else {
      typeCell.innerHTML = typeSelectMarkup(device);
      const typeSelect = typeCell.querySelector(".type-select");
      if (typeSelect) {
        typeSelect.addEventListener("change", () => setDeviceType(device, typeSelect.value, typeSelect));
      }
    }

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
        toast(device.label ? `Label saved for ${macText(device.mac)}.` : "Label cleared.", "ok");
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

  // ------------------------------------------------------------------- 3d map
  function keyForDevice(device) {
    return device.mac || (device.ip ? `ip:${device.ip}` : "");
  }

  function nodeColor(device) {
    const key = device.is_gateway ? "router" : device.is_self ? "self" : (device.type || "other");
    if (window.NetDash3D && typeof window.NetDash3D.typeColor === "function") {
      return window.NetDash3D.typeColor(key, state.theme);
    }
    const types = (window.NetDash3D && window.NetDash3D.TYPES) || {};
    return (types[key] || types.other || { color: "#2dd4bf" }).color;
  }

  function syntheticRouter() {
    const snapshot = state.snapshot || {};
    const router = snapshot.router || {};
    const net = snapshot.network || {};
    return {
      ip: router.host || net.gateway || "",
      mac: "",
      name: router.model || "Router",
      vendor: "",
      type: "router",
      online: !!router.connected,
      state: "router",
      is_gateway: true,
      is_self: false,
      blocked: false,
      wifi_blocked: false,
      connection: "lan",
      source: "router",
    };
  }

  function panelDevice(key) {
    if (!key) return null;
    const found = state.devices.find((device) => keyForDevice(device) === key);
    if (found) return found;
    if (key === "__router__") {
      return state.devices.find((device) => device.is_gateway) || syntheticRouter();
    }
    return null;
  }

  function ensureScene() {
    if (state.scene) return state.scene;
    if (!window.NetDash3D || !ui.sceneCanvas) return null;
    state.scene = window.NetDash3D.create({
      canvas: ui.sceneCanvas,
      onSelect: (device, key) => select3dNode(device, key),
      onLinkAction: (device, key) => toggle3dLink(device, key),
      onHover: showSceneTip,
    });
    return state.scene;
  }

  function syncScene() {
    updateLegendState();
    if (!state.scene) return;
    const snapshot = state.snapshot || {};
    const router = snapshot.router || {};
    const caps = router.capabilities || {};
    state.scene.sync({
      devices: state.devices,
      router,
      network: snapshot.network || {},
      canControl: !!router.connected && !!caps.block,
      canWifi: !!router.connected && !!caps.wifi,
      hideOffline: !!state.hideOffline,
      focusTypes: state.focusTypes.slice(),
      theme: state.theme,
    });
    updateSceneHud();
  }

  function updateSceneHud() {
    const total = state.devices.length;
    const online = state.devices.filter((device) => device.online).length;
    const blocked = state.devices.filter((device) => device.blocked).length;
    ui.sceneOnline.textContent = String(online);
    ui.sceneOffline.textContent = String(Math.max(0, total - online));
    ui.sceneBlocked.textContent = String(blocked);
    const hiddenOffline = Math.max(0, total - online);
    ui.sceneOffline.parentElement.title = state.hideOffline && hiddenOffline
      ? `${hiddenOffline} offline device${hiddenOffline === 1 ? "" : "s"} hidden from the map`
      : "";

    const router = (state.snapshot && state.snapshot.router) || {};
    ui.sceneRouterStat.classList.toggle("live", !!router.connected);
    ui.sceneRouterText.textContent = router.connected
      ? `${router.model || "Router"} connected`
      : "Router not connected";

    const satellites = state.devices.filter((device) => !device.is_gateway);
    const visible = satellites.filter((device) => !state.hideOffline || device.online !== false).length;
    const empty = satellites.length === 0 || visible === 0;
    ui.sceneEmpty.hidden = !empty;
    if (empty) {
      const payload = state.lastPayload || {};
      if (satellites.length === 0) {
        ui.sceneEmptyText.textContent = payload.scanning
          ? "Scanning the local network…"
          : "No devices yet. Run a scan to build the map.";
      } else {
        ui.sceneEmptyText.textContent =
          "All devices are offline. Turn off the eye filter to show them.";
      }
    }
  }

  function updateHideOfflineButton() {
    const active = !!state.hideOffline;
    ui.sceneHideOffline.setAttribute("aria-pressed", active ? "true" : "false");
    ui.sceneHideOffline.title = active ? "Show offline devices" : "Hide offline devices";
    ui.sceneHideOffline.setAttribute(
      "aria-label", active ? "Show offline devices" : "Hide offline devices",
    );
  }

  function toggleHideOffline() {
    state.hideOffline = !state.hideOffline;
    updateHideOfflineButton();
    try {
      localStorage.setItem("netdash-hide-offline", state.hideOffline ? "1" : "0");
    } catch (error) {
      /* private mode: remembering the filter is optional */
    }
    syncScene();
    if (state.hideOffline && state.panelKey) {
      const device = panelDevice(state.panelKey);
      if (device && !device.is_gateway && device.online === false) closeNodePanel();
    }
  }

  function updateLegendState() {
    let present;
    if (!state.devicesLoaded) {
      present = new Set([...ui.legendItems].map((item) => item.dataset.type));
    } else {
      const visible = state.devices.filter(
        (device) => device.is_gateway || !state.hideOffline || device.online !== false,
      );
      present = new Set(
        visible.map((device) => (device.is_gateway ? "router" : (device.type || "other"))),
      );
      present.add("router");
    }

    state.focusTypes = state.focusTypes.filter((type) => present.has(type));
    const activeCount = state.focusTypes.length;
    ui.sceneLegend.classList.toggle("has-focus", activeCount > 0);
    ui.legendClear.hidden = activeCount === 0;

    for (const item of ui.legendItems) {
      const type = item.dataset.type;
      const available = present.has(type);
      const active = available && state.focusTypes.includes(type);
      item.hidden = !available;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
      const label = item.textContent.trim();
      item.title = active
        ? `Remove ${label} from focus`
        : `Add ${label} to focus`;
    }
  }

  function setFocusType(type) {
    const index = state.focusTypes.indexOf(type);
    if (index >= 0) {
      state.focusTypes.splice(index, 1);
    } else {
      state.focusTypes.push(type);
    }
    syncScene();
  }

  function clearFocus() {
    if (!state.focusTypes.length) return;
    state.focusTypes = [];
    syncScene();
  }

  const themeQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function resolveTheme(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return themeQuery && !themeQuery.matches ? "light" : "dark";
  }

  function updateAppearance() {
    for (const button of ui.appearanceButtons) {
      const active = button.dataset.themeMode === state.themeMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    document.documentElement.dataset.themeMode = state.themeMode;
    document.documentElement.style.colorScheme = state.theme;
  }

  function applyTheme(mode, options = {}) {
    const { persist = true, animate = true } = options;
    state.themeMode = ["auto", "light", "dark"].includes(mode) ? mode : "auto";
    const next = resolveTheme(state.themeMode);
    const changed = document.documentElement.dataset.theme !== next;
    const commit = () => {
      state.theme = next;
      document.documentElement.dataset.theme = next;
      updateAppearance();
      syncScene();
      refreshNodePanel();
    };
    if (animate && changed && !prefersReducedMotion() && state.view !== "3d"
      && typeof document.startViewTransition === "function") {
      document.startViewTransition(commit);
    } else {
      commit();
    }
    if (persist) {
      try {
        localStorage.setItem("netdash-theme", state.themeMode);
      } catch (error) {
        /* private mode: remembering the appearance is optional */
      }
    }
  }

  if (themeQuery) {
    const onSystemTheme = () => {
      if (state.themeMode === "auto") applyTheme("auto", { persist: false });
    };
    if (typeof themeQuery.addEventListener === "function") {
      themeQuery.addEventListener("change", onSystemTheme);
    } else if (typeof themeQuery.addListener === "function") {
      themeQuery.addListener(onSystemTheme);
    }
  }

  function setView(view, persist = true) {
    const target = view === "3d" ? "3d" : "dashboard";
    state.view = target;
    document.body.classList.toggle("scene-mode", target === "3d");
    ui.viewDashboard.hidden = target !== "dashboard";
    ui.view3d.hidden = target !== "3d";
    for (const tab of ui.viewTabs) {
      const active = tab.dataset.view === target;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }

    const visible = target === "3d" ? ui.view3d : ui.viewDashboard;
    visible.classList.remove("view-enter");
    requestAnimationFrame(() => {
      visible.classList.add("view-enter");
      setTimeout(() => visible.classList.remove("view-enter"), 300);
    });

    if (target === "3d") {
      ensureScene();
      syncScene();
      if (state.scene) {
        state.scene.setActive(true);
        requestAnimationFrame(() => {
          if (state.scene) state.scene.resize();
        });
      }
    } else {
      showSceneTip(null);
      if (state.scene) state.scene.setActive(false);
      if (isSceneFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          const result = exit.call(document);
          if (result && typeof result.catch === "function") result.catch(() => {});
        }
      }
    }
    if (persist) {
      try {
        localStorage.setItem("netdash-view", target);
      } catch (error) {
        /* private mode: remembering the tab is optional */
      }
    }
  }

  function isSceneFullscreen() {
    return (document.fullscreenElement || document.webkitFullscreenElement) === ui.sceneShell;
  }

  function syncFullscreenButton() {
    const active = isSceneFullscreen();
    ui.sceneFullscreen.setAttribute("aria-pressed", active ? "true" : "false");
    ui.sceneFullscreen.title = active ? "Exit full screen" : "Full screen";
    ui.sceneFullscreen.setAttribute(
      "aria-label", active ? "Exit full screen" : "Enter full screen",
    );
  }

  async function toggleSceneFullscreen() {
    try {
      if (isSceneFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        return;
      }
      const request = ui.sceneShell.requestFullscreen || ui.sceneShell.webkitRequestFullscreen;
      if (!request) throw new Error("Full screen is not available in this browser.");
      await request.call(ui.sceneShell);
    } catch (error) {
      toast(error.message || "Could not enter full screen.", "error",
        "Your browser may block full screen for this page.");
    }
  }

  function onFullscreenChange() {
    syncFullscreenButton();
    requestAnimationFrame(() => {
      if (!state.scene) return;
      state.scene.resize();
      state.scene.fit();
    });
  }

  function showSceneTip(info) {
    if (!info) {
      ui.sceneTip.hidden = true;
      return;
    }
    ui.sceneTip.hidden = false;
    ui.sceneTip.className = `scene-tip ${info.tone || ""}`;
    ui.sceneTip.innerHTML =
      `${escapeHtml(info.title)}<span class="tip-sub">${escapeHtml(info.subtitle || "")}</span>`;
    const box = ui.sceneShell.getBoundingClientRect();
    const tipWidth = 236;
    const tipHeight = 46;
    let x = info.x + 16;
    let y = info.y + 16;
    if (x + tipWidth > box.width - 8) x = info.x - tipWidth - 10;
    if (y + tipHeight > box.height - 8) y = info.y - tipHeight - 10;
    ui.sceneTip.style.left = `${Math.max(8, x)}px`;
    ui.sceneTip.style.top = `${Math.max(8, y)}px`;
  }

  function select3dNode(device, key) {
    const panelKey = key || keyForDevice(device);
    state.selectedKey = panelKey;
    state.panelKey = panelKey;
    if (state.scene) state.scene.setSelected(panelKey);
    ui.nodePanel.hidden = false;
    renderNodePanel(device, panelKey);
  }

  function closeNodePanel() {
    state.panelKey = "";
    state.selectedKey = "";
    state.panelEditing = false;
    ui.nodePanel.hidden = true;
    ui.nodePanel.innerHTML = "";
    if (state.scene) state.scene.setSelected("");
  }

  function refreshNodePanel() {
    if (!state.panelKey || ui.nodePanel.hidden || state.panelEditing) return;
    const device = panelDevice(state.panelKey);
    if (!device) {
      closeNodePanel();
      return;
    }
    if (state.hideOffline && !device.is_gateway && device.online === false) {
      closeNodePanel();
      return;
    }
    renderNodePanel(device, state.panelKey);
  }

  function renderNodePanel(device, key) {
    if (!device) {
      closeNodePanel();
      return;
    }
    const isRouter = !!device.is_gateway;
    const snapshot = state.snapshot || {};
    const router = snapshot.router || {};
    const caps = router.capabilities || {};
    const net = snapshot.network || {};
    const canControl = !!router.connected && !!caps.block;
    const canWifi = !!router.connected && !!caps.wifi;
    const color = nodeColor(device);
    const name = device.label || device.name || device.vendor || device.ip
      || (isRouter ? "Router" : "Device");
    const online = device.online !== false;

    let statusText = "Offline";
    let statusClass = "offline";
    if (online) {
      statusText = isRouter
        ? (router.connected ? "Router connected" : "Gateway")
        : (device.state === "router" ? "On router" : "Online");
      statusClass = "online";
    } else if (device.responded === false) {
      statusText = "Last seen";
    }

    const tags = [];
    if (device.is_self) tags.push('<span class="tag you">You</span>');
    if (isRouter) tags.push('<span class="tag router">Router</span>');
    if (device.blocked) tags.push('<span class="tag blocked">Blocked</span>');
    if (device.wifi_blocked) tags.push('<span class="tag blocked">Wi-Fi blocked</span>');
    if (device.random_mac) tags.push('<span class="tag">Private MAC</span>');

    const fact = (label, value, mono = false) => {
      if (value === undefined || value === null || value === "") return "";
      return `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHtml(value)}</dd>`;
    };

    const facts = [];
    if (isRouter) {
      facts.push(fact("Model", router.model || device.name || "Unknown"));
      facts.push(fact("Admin address", router.host || device.ip || "", true));
      facts.push(fact("Control", router.connected ? "Connected" : "Not connected"));
      facts.push(fact("Internet filter", caps.block ? "Available" : "Unavailable"));
      facts.push(fact("Wi-Fi filter", caps.wifi ? "Available" : "Unavailable"));
      facts.push(fact("Devices seen", String(state.devices.filter((item) => !item.is_gateway).length)));
      if ((caps.notes || []).length) facts.push(fact("Router note", caps.notes[0]));
    } else {
      if (device.label && device.name) facts.push(fact("Hostname", device.name));
      facts.push(fact("Address", device.ip || "—", true));
      facts.push(`<dt>MAC address</dt><dd class="mono">${macMarkup(device.mac, "Unknown")}</dd>`);
      facts.push(fact("Vendor", device.vendor || "Unresolved"));
      if (device.mac) {
        facts.push(`<dt>Type</dt><dd class="type-fact">${typeSelectMarkup(device)}</dd>`);
      } else {
        facts.push(fact("Type", TYPE_LABELS[device.type] || "Device"));
      }
      if (device.connection) {
        facts.push(fact(
          "Connection",
          device.connection === "lan"
            ? "Ethernet"
            : `Wi-Fi${device.ssid ? ` · ${device.ssid}` : ""}`,
        ));
      }
      if (device.source) {
        const sources = {
          lan: "Ping + ARP", router: "Router client list", "lan+router": "Ping + router",
        };
        facts.push(fact("Discovered", sources[device.source] || device.source));
      }
      if (device.last_seen) facts.push(fact("Last seen", timeAgo(device.last_seen)));
      if (device.is_self) {
        facts.push(fact("Interface", net.interface || ""));
        if (net.link_mbps) facts.push(fact("Link rate", `${Math.round(net.link_mbps)} Mbps`));
        if (net.signal_dbm) facts.push(fact("Signal", `${net.signal_dbm} dBm`));
        if (net.rx_bytes !== undefined || net.tx_bytes !== undefined) {
          facts.push(fact("Traffic", `↓ ${fmtBytes(net.rx_bytes)}   ↑ ${fmtBytes(net.tx_bytes)}`));
        }
      }
    }

    const canToggleInternet = canControl && !isRouter && !device.is_self && !!device.mac;
    const wifiDevice = device.connection !== "lan";
    const canToggleWifi = canWifi && !isRouter && !device.is_self && !!device.mac && wifiDevice;

    const accessRow = (scope, title, hint, checked, enabled) => `
      <div class="access-row ${enabled ? "" : "locked"}" data-scope="${scope}">
        <div class="access-text">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(hint)}</span>
        </div>
        ${switchMarkup(`toggle-${scope}`, device.mac || "", checked, enabled, `${title}: ${hint}`)}
      </div>`;

    let accessHtml = "";
    if (!isRouter) {
      const internetHint = canToggleInternet
        ? "Router firewall MAC filter"
        : (device.is_self ? "NetDash never blocks this computer" : "Connect the router to control access");
      const wifiHint = canToggleWifi
        ? "Router WLAN access control"
        : (!canWifi
          ? "Not available on this router"
          : (wifiDevice ? "Connect the router to control access" : "This device uses Ethernet"));
      accessHtml = `
        <div class="node-access">
          ${accessRow("internet", "Internet access", internetHint, !device.blocked, canToggleInternet)}
          ${accessRow("wifi", "Wi-Fi access", wifiHint, !device.wifi_blocked, canToggleWifi)}
        </div>`;
    }

    const adminAddress = router.host || device.ip || "";
    const adminLink = isRouter && adminAddress
      ? `<a class="btn ghost" href="https://${escapeHtml(adminAddress)}/" target="_blank" rel="noopener noreferrer">Admin page</a>`
      : "";
    const connectionText = device.connection === "lan"
      ? "Ethernet"
      : (device.connection ? "Wi-Fi" : "Network");

    ui.nodePanel.innerHTML = `
      <div class="node-panel-head">
        <span class="node-badge" style="color:${color}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${deviceIcon(device)}</svg>
        </span>
        <div class="node-id">
          <div class="node-name" id="node-panel-name">${escapeHtml(name)}</div>
          <div class="node-kind">${escapeHtml(isRouter ? "Network hub" : (TYPE_LABELS[device.type] || "Device"))} · ${escapeHtml(connectionText)}</div>
        </div>
        <button class="btn ghost icon-only node-close" type="button" aria-label="Close details">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="icon"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      ${tags.length ? `<div class="node-tags">${tags.join("")}</div>` : ""}
      <div class="node-status">
        <span class="status ${statusClass}"><i></i>${statusText}</span>
        <span class="addr">${escapeHtml(device.ip || "")}</span>
      </div>
      <div class="node-buttons">
        <button class="btn" type="button" data-act="focus">Center in view</button>
        ${device.mac ? '<button class="btn ghost" type="button" data-act="rename">Rename</button>' : ""}
        ${adminLink}
      </div>
      <dl class="node-facts">${facts.join("")}</dl>
      ${accessHtml}
      <p class="node-note">${isRouter
        ? "The router is the hub every link terminates at. Devices come from the local scan and the router's client list."
        : (canControl
          ? "Access changes are written to the router and verified by reading the rule list back."
          : "Connect the router in Settings to switch internet access from this map.")}</p>`;

    ui.nodePanel.querySelector(".node-close").addEventListener("click", closeNodePanel);
    const focusButton = ui.nodePanel.querySelector('[data-act="focus"]');
    if (focusButton) {
      focusButton.addEventListener("click", () => {
        if (state.scene) state.scene.focus(key);
      });
    }
    const renameButton = ui.nodePanel.querySelector('[data-act="rename"]');
    if (renameButton) {
      renameButton.addEventListener("click", () => startPanelRename(device, key));
    }
    const typeSelect = ui.nodePanel.querySelector(".type-select");
    if (typeSelect) {
      typeSelect.addEventListener("change", () => setDeviceType(device, typeSelect.value, typeSelect));
    }
    const internetInput = ui.nodePanel.querySelector(".toggle-internet input");
    if (internetInput) {
      internetInput.addEventListener("change", () => setAccess(device, "internet", internetInput));
    }
    const wifiInput = ui.nodePanel.querySelector(".toggle-wifi input");
    if (wifiInput) {
      wifiInput.addEventListener("change", () => setAccess(device, "wifi", wifiInput));
    }
    for (const row of ui.nodePanel.querySelectorAll(".access-row.locked")) {
      row.addEventListener("click", () => explainAccess(device));
    }
    state.panelEditing = false;
  }

  function startPanelRename(device, key) {
    const nameNode = ui.nodePanel.querySelector("#node-panel-name");
    if (!nameNode || !device.mac || nameNode.querySelector("input")) return;
    state.panelEditing = true;
    const input = document.createElement("input");
    input.className = "node-name-input";
    input.type = "text";
    input.maxLength = 48;
    input.value = device.label || "";
    input.placeholder = device.name || "Label";
    nameNode.textContent = "";
    nameNode.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (!save || value === (device.label || "")) {
        state.panelEditing = false;
        refreshNodePanel();
        return;
      }
      try {
        const result = await api("/api/device/label", {
          method: "POST",
          body: { mac: device.mac, label: value },
        });
        device.label = result.label || "";
        toast(result.label ? "Label saved." : "Label cleared.", "ok");
        await refreshDevices(false);
      } catch (error) {
        toast(error.message || "Could not save the label.", "error", error.hint || "");
      } finally {
        state.panelEditing = false;
        refreshNodePanel();
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function toggle3dLink(device, key) {
    if (!device) return;
    select3dNode(device, key);
    if (device.is_gateway) return;
    if (device.is_self) {
      toast("NetDash will not block the computer it runs on.", "error");
      return;
    }
    if (device.online === false) {
      toast("This device is offline, so there is nothing to disconnect.", "error");
      return;
    }
    const router = (state.snapshot && state.snapshot.router) || {};
    const caps = router.capabilities || {};
    if (!router.connected || !caps.block) {
      explainAccess(device);
      return;
    }
    setAccess(device, "internet", null, !!device.blocked);
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

  async function setAccess(device, scope, input, forcedAllowed) {
    const label = scope === "wifi" ? "Wi-Fi access" : "Internet access";
    const allowed = forcedAllowed === undefined ? input.checked : !!forcedAllowed;
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
        if (input) input.checked = true;
        return;
      }
    }

    const cell = input ? input.closest("td.toggle-cell") : null;
    if (input) input.disabled = true;
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
      if (input) input.checked = !allowed;
      toast(error.message || "Could not change device access.", "error", error.hint || "");
    } finally {
      if (cell && cell.isConnected) {
        cell.classList.remove("busy");
        input.disabled = false;
      }
    }
  }

  async function setDeviceType(device, type, control) {
    if (!device || !device.mac) return;
    const autoLabel = TYPE_LABELS[device.auto_type || device.type] || "Other";
    if (control) control.disabled = true;
    try {
      await api("/api/device/type", {
        method: "POST",
        body: { mac: device.mac, type },
      });
      toast(
        type === "auto"
          ? `Type reset to automatic (${autoLabel}).`
          : `Type set to ${TYPE_LABELS[type] || type}.`,
        "ok",
      );
      await refreshDevices(false);
    } catch (error) {
      toast(error.message || "Could not change the device type.", "error", error.hint || "");
      if (control && control.isConnected) {
        control.value = device.type_override || "auto";
      }
    } finally {
      if (control && control.isConnected) control.disabled = false;
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
  let drawerTimer = null;

  function openDrawer() {
    clearTimeout(drawerTimer);
    ui.drawer.hidden = false;
    ui.drawerBackdrop.hidden = false;
    ui.drawer.setAttribute("aria-hidden", "false");
    // Flush the closed transform first so the open transition always runs.
    void ui.drawer.offsetWidth;
    ui.drawer.classList.add("open");
    ui.drawerBackdrop.classList.add("open");
    loadSettings();
  }

  function closeDrawer() {
    ui.drawer.classList.remove("open");
    ui.drawerBackdrop.classList.remove("open");
    ui.drawer.setAttribute("aria-hidden", "true");
    const finish = () => {
      if (!ui.drawer.classList.contains("open")) {
        ui.drawer.hidden = true;
        ui.drawerBackdrop.hidden = true;
      }
    };
    clearTimeout(drawerTimer);
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    drawerTimer = setTimeout(finish, 300);
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
      state.hideOffline = localStorage.getItem("netdash-hide-offline") === "1";
      state.showMac = localStorage.getItem("netdash-show-mac") !== "0";
      const storedTheme = localStorage.getItem("netdash-theme") || "auto";
      state.themeMode = ["auto", "light", "dark"].includes(storedTheme) ? storedTheme : "auto";
    } catch (error) {
      /* storage is optional */
    }
    state.theme = resolveTheme(state.themeMode);
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    updateAppearance();
    updateHideOfflineButton();
    updateLegendState();
    if (ui.showMac) ui.showMac.checked = state.showMac;

    try {
      await refreshState();
    } catch (error) {
      toast(error.message || "Could not load NetDash.", "error");
      return;
    }
    ui.routerHost.placeholder = (state.snapshot.network && state.snapshot.network.gateway) || "192.168.1.1";

    let savedView = "";
    try {
      savedView = localStorage.getItem("netdash-view") || "";
    } catch (error) {
      /* storage is optional */
    }
    if (savedView === "3d") setView("3d", false);

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
  ui.showMac.addEventListener("change", () => applyShowMac(ui.showMac.checked));
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

  for (const tab of ui.viewTabs) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }
  for (const button of ui.appearanceButtons) {
    button.addEventListener("click", () => applyTheme(button.dataset.themeMode));
  }
  $("#scene-scan").addEventListener("click", doScan);
  $("#scene-empty-scan").addEventListener("click", doScan);
  ui.sceneRotate.addEventListener("click", () => {
    if (!state.scene) return;
    const next = !state.scene.getAutoRotate();
    state.scene.setAutoRotate(next);
    ui.sceneRotate.setAttribute("aria-pressed", next ? "true" : "false");
    ui.sceneRotate.title = next ? "Stop auto rotation" : "Start auto rotation";
  });
  ui.sceneHideOffline.addEventListener("click", toggleHideOffline);
  for (const item of ui.legendItems) {
    item.addEventListener("click", () => setFocusType(item.dataset.type));
  }
  ui.legendClear.addEventListener("click", clearFocus);
  $("#scene-zoom-in").addEventListener("click", () => state.scene && state.scene.zoomBy(0.82));
  $("#scene-zoom-out").addEventListener("click", () => state.scene && state.scene.zoomBy(1.22));
  $("#scene-reset").addEventListener("click", () => state.scene && state.scene.reset());
  ui.sceneFullscreen.addEventListener("click", toggleSceneFullscreen);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // Masked MAC addresses reveal while hovered (CSS) and toggle on tap/click
  // or Enter/Space, so a screenshot never shows an address that is hidden.
  document.addEventListener("click", (event) => {
    const node = event.target instanceof Element
      ? event.target.closest(".mac-value.masked")
      : null;
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    toggleMacReveal(node);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const node = event.target instanceof Element
      ? event.target.closest(".mac-value.masked")
      : null;
    if (!node) return;
    event.preventDefault();
    toggleMacReveal(node);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.key === "f" || event.key === "F")
      && document.activeElement === ui.sceneCanvas
      && state.view === "3d") {
      event.preventDefault();
      toggleSceneFullscreen();
      return;
    }
    if (event.key !== "Escape") return;
    if (isSceneFullscreen()) return;
    if (!ui.drawer.hidden) {
      closeDrawer();
    } else if (!ui.nodePanel.hidden && !state.panelEditing) {
      closeNodePanel();
    }
  });

  boot();
})();
