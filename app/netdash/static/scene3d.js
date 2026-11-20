/* NetDash 3D network map.
 *
 * A dependency-free canvas renderer:
 *   - perspective projection and an orbit camera (drag / wheel / pinch / keys)
 *   - billboarded device shapes drawn with vector primitives
 *   - animated links from the router, each with a clickable action icon
 *   - hover and click hit-testing, depth sorting, floor grid and shadows
 *
 * The module only renders. NetDash's data and API stay in app.js.
 */
(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const FLOOR_Y = -1.5;
  const ROUTER_Y = 1.25;
  // Tree layout: the router hangs at the top, devices sit in a grid of
  // branches below it, joined by one trunk and a horizontal arm per row.
  const TREE_TOP = 7.4;
  // Leave a visible stretch of trunk between the router and the first row.
  const TREE_FIRST_ROW = TREE_TOP - 4;
  // Rows need room for the shape plus its label underneath, and for the next
  // row's arm to clear that label.
  const TREE_ROW_GAP = 3.4;
  const TREE_COL_GAP = 3.6;
  const TREE_ARM_LIFT = TREE_ROW_GAP / 2 - 0.25;
  const TREE_MAX_COLS = 5;
  // Each branch runs in its own lane so the lines never overlap: x offset for
  // the vertical run, y offset for the horizontal run within a row.
  const TREE_LANE_X = 0.22;
  const TREE_LANE_Y = 0.14;
  const FOV_DEG = 46;
  const MIN_DIST = 12;
  const MAX_DIST = 70;
  const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const REDUCED_MOTION = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TYPES = {
    router: { color: "#b39cff", lightColor: "#6941e6", name: "Router" },
    self: { color: "#2dd4bf", lightColor: "#0f8a7a", name: "This computer" },
    computer: { color: "#67b7ff", lightColor: "#0b6bcb", name: "Desktop PC" },
    laptop: { color: "#4fd1e3", lightColor: "#0a7f8f", name: "Laptop" },
    tablet: { color: "#9d8cff", lightColor: "#5b4bd6", name: "Tablet" },
    phone: { color: "#6aa9ff", lightColor: "#0b63ce", name: "Phone" },
    tv: { color: "#e879f9", lightColor: "#b21bb5", name: "TV" },
    camera: { color: "#ff6b8b", lightColor: "#c81e4a", name: "Camera" },
    light: { color: "#ffd166", lightColor: "#a16207", name: "Smart light" },
    xbox: { color: "#5ee08a", lightColor: "#15803d", name: "Xbox" },
    playstation: { color: "#8b8cff", lightColor: "#3f51e0", name: "PlayStation" },
    speaker: { color: "#ff9f5a", lightColor: "#c2410c", name: "Speaker" },
    printer: { color: "#ff8fa3", lightColor: "#be123c", name: "Printer" },
    console: { color: "#86efac", lightColor: "#166534", name: "Console" },
    iot: { color: "#f8c14a", lightColor: "#b45309", name: "IoT device" },
    other: { color: "#9a9aa6", lightColor: "#6b6b75", name: "Device" },
  };

  const SCENE_PALETTES = {
    dark: {
      labelBg: "rgba(16, 16, 19, 0.9)",
      labelBgMuted: "rgba(16, 16, 19, 0.64)",
      labelText: "#f3f0eb",
      labelMuted: "#a6a1aa",
      grid: "rgba(255, 255, 255, 0.055)",
      ring: "rgba(255, 255, 255, 0.1)",
      ringSoft: "rgba(255, 255, 255, 0.06)",
      shadow: "rgba(0, 0, 0, 0.45)",
      dim: "#77727e",
      floorGlow: "rgba(255, 92, 77, 0.1)",
      floorGlowSoft: "rgba(255, 255, 255, 0.04)",
      beam: "rgba(255, 92, 77, 0.22)",
      plugBg: "rgba(16, 16, 19, 0.96)",
      reconnect: "#4ade80",
    },
    light: {
      labelBg: "rgba(255, 253, 248, 0.94)",
      labelBgMuted: "rgba(255, 253, 248, 0.72)",
      labelText: "#201e23",
      labelMuted: "#6e6975",
      grid: "rgba(31, 29, 34, 0.06)",
      ring: "rgba(31, 29, 34, 0.1)",
      ringSoft: "rgba(31, 29, 34, 0.055)",
      shadow: "rgba(50, 40, 25, 0.18)",
      dim: "#8d8793",
      floorGlow: "rgba(217, 58, 32, 0.1)",
      floorGlowSoft: "rgba(31, 29, 34, 0.03)",
      beam: "rgba(31, 29, 34, 0.18)",
      plugBg: "rgba(255, 253, 248, 0.96)",
      reconnect: "#15803d",
    },
  };

  const BLOCK_COLOR = "#f87171";

  // ------------------------------------------------------------------ math
  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => vec(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
  const norm = (a) => {
    const length = Math.hypot(a.x, a.y, a.z) || 1;
    return vec(a.x / length, a.y / length, a.z / length);
  };
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const lerp = (a, b, t) => a + (b - a) * t;

  function hexToRgb(hex) {
    const value = String(hex).replace("#", "");
    const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function shade(hex, amount) {
    const { r, g, b } = hexToRgb(hex);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    return `rgb(${Math.round(r + (target - r) * p)}, `
      + `${Math.round(g + (target - g) * p)}, ${Math.round(b + (target - b) * p)})`;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function typeColor(key, theme = "dark") {
    const entry = TYPES[key] || TYPES.other;
    return theme === "light" ? (entry.lightColor || entry.color) : entry.color;
  }

  function styleFor(device, theme = "dark") {
    const key = device && device.is_gateway
      ? "router"
      : device && device.is_self
        ? "self"
        : (device && device.type) || "other";
    const entry = TYPES[key] || TYPES.other;
    return { ...entry, color: typeColor(key, theme) };
  }

  function nodeKey(device) {
    return (device && (device.mac || `ip:${device.ip}`)) || "__unknown__";
  }

  // ----------------------------------------------------------------- shapes
  function drawRouterShape(ctx, s, color) {
    const w = s * 1.38;
    const bodyH = s * 1.25;
    const top = -bodyH * 0.36;

    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = Math.max(1.3, s * 0.055);
    ctx.lineCap = "round";
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(dir * w * 0.28, top + 3);
      ctx.lineTo(dir * w * 0.5, top - s * 0.74);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(dir * w * 0.5, top - s * 0.74, Math.max(1.6, s * 0.08), 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
    }

    const body = ctx.createLinearGradient(0, top, 0, top + bodyH);
    body.addColorStop(0, shade(color, 0.45));
    body.addColorStop(0.5, shade(color, 0.02));
    body.addColorStop(1, shade(color, -0.62));
    roundedRect(ctx, -w / 2, top, w, bodyH, s * 0.16);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    roundedRect(ctx, -w * 0.36, top + s * 0.16, w * 0.72, s * 0.15, s * 0.075);
    ctx.fillStyle = "rgba(255, 255, 255, 0.26)";
    ctx.fill();

    const leds = ["#5eead4", "#fbbf24", "#f472b6"];
    leds.forEach((led, index) => {
      ctx.beginPath();
      ctx.arc(-w * 0.22 + index * w * 0.22, top + bodyH * 0.6, Math.max(1.4, s * 0.065), 0, TAU);
      ctx.fillStyle = led;
      ctx.fill();
    });

    ctx.strokeStyle = rgba(color, 0.35);
    ctx.lineWidth = Math.max(1, s * 0.03);
    for (let i = 0; i < 3; i += 1) {
      const y = top + bodyH * 0.78 + i * s * 0.075;
      ctx.beginPath();
      ctx.moveTo(-w * 0.27, y);
      ctx.lineTo(w * 0.27, y);
      ctx.stroke();
    }
  }

  function drawComputerShape(ctx, s, color) {
    const mw = s * 1.44;
    const mh = s * 1.02;
    const mx = -s * 0.16;

    // Tower case.
    const tower = ctx.createLinearGradient(s * 0.63, 0, s * 0.96, 0);
    tower.addColorStop(0, shade(color, 0.24));
    tower.addColorStop(1, shade(color, -0.6));
    roundedRect(ctx, s * 0.62, -s * 0.6, s * 0.35, s * 1.22, s * 0.08);
    ctx.fillStyle = tower;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.8);
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(s * 0.8, -s * 0.38, Math.max(1.3, s * 0.055), 0, TAU);
    ctx.fillStyle = "#5eead4";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.8, -s * 0.22, Math.max(1.2, s * 0.045), 0, TAU);
    ctx.fillStyle = rgba(color, 0.65);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.35);
    ctx.lineWidth = Math.max(1, s * 0.028);
    for (let i = 0; i < 3; i += 1) {
      const y = s * 0.1 + i * s * 0.1;
      ctx.beginPath();
      ctx.moveTo(s * 0.7, y);
      ctx.lineTo(s * 0.9, y);
      ctx.stroke();
    }

    // Monitor stand.
    ctx.strokeStyle = rgba(color, 0.75);
    ctx.lineWidth = Math.max(1.4, s * 0.06);
    ctx.beginPath();
    ctx.moveTo(mx, mh * 0.42);
    ctx.lineTo(mx, mh * 0.74);
    ctx.stroke();
    roundedRect(ctx, mx - mw * 0.2, mh * 0.7, mw * 0.4, s * 0.13, s * 0.06);
    ctx.fillStyle = shade(color, -0.55);
    ctx.fill();

    // Monitor.
    const frame = ctx.createLinearGradient(0, -mh * 0.55, 0, mh * 0.5);
    frame.addColorStop(0, shade(color, 0.42));
    frame.addColorStop(1, shade(color, -0.62));
    roundedRect(ctx, mx - mw / 2, -mh * 0.55, mw, mh, s * 0.11);
    ctx.fillStyle = frame;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    const screen = ctx.createLinearGradient(0, -mh * 0.4, 0, mh * 0.34);
    screen.addColorStop(0, "rgba(5, 12, 20, 0.96)");
    screen.addColorStop(1, rgba(color, 0.24));
    roundedRect(ctx, mx - mw * 0.42, -mh * 0.42, mw * 0.84, mh * 0.72, s * 0.06);
    ctx.fillStyle = screen;
    ctx.fill();

    ctx.strokeStyle = rgba(color, 0.8);
    ctx.lineWidth = Math.max(1, s * 0.035);
    for (let i = 0; i < 3; i += 1) {
      const y = -mh * 0.28 + i * mh * 0.16;
      ctx.beginPath();
      ctx.moveTo(mx - mw * 0.32, y);
      ctx.lineTo(mx + mw * (0.12 - i * 0.12), y);
      ctx.stroke();
    }
  }

  function drawLaptopShape(ctx, s, color) {
    const w = s * 1.78;
    const h = s * 1.04;
    const top = -h * 0.66;

    const lid = ctx.createLinearGradient(0, top, 0, top + h);
    lid.addColorStop(0, shade(color, 0.45));
    lid.addColorStop(1, shade(color, -0.58));
    roundedRect(ctx, -w * 0.42, top, w * 0.84, h * 0.94, s * 0.09);
    ctx.fillStyle = lid;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    const screen = ctx.createLinearGradient(0, top + s * 0.1, 0, top + h * 0.78);
    screen.addColorStop(0, "rgba(5, 12, 20, 0.97)");
    screen.addColorStop(1, rgba(color, 0.28));
    roundedRect(ctx, -w * 0.35, top + s * 0.1, w * 0.7, h * 0.68, s * 0.05);
    ctx.fillStyle = screen;
    ctx.fill();

    ctx.strokeStyle = rgba(color, 0.8);
    ctx.lineWidth = Math.max(1, s * 0.032);
    for (let i = 0; i < 3; i += 1) {
      const y = top + s * 0.26 + i * s * 0.16;
      ctx.beginPath();
      ctx.moveTo(-w * 0.27, y);
      ctx.lineTo(w * (0.08 - i * 0.1), y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, top + s * 0.055, Math.max(1.1, s * 0.035), 0, TAU);
    ctx.fillStyle = rgba(color, 0.9);
    ctx.fill();

    const baseY = top + h * 0.94;
    const base = ctx.createLinearGradient(0, baseY, 0, baseY + s * 0.3);
    base.addColorStop(0, shade(color, 0.34));
    base.addColorStop(1, shade(color, -0.62));
    ctx.beginPath();
    ctx.moveTo(-w * 0.55, baseY);
    ctx.lineTo(w * 0.55, baseY);
    ctx.lineTo(w * 0.42, baseY + s * 0.28);
    ctx.lineTo(-w * 0.42, baseY + s * 0.28);
    ctx.closePath();
    ctx.fillStyle = base;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.stroke();

    ctx.strokeStyle = rgba(color, 0.4);
    ctx.lineWidth = Math.max(1, s * 0.022);
    for (let i = 0; i < 3; i += 1) {
      const y = baseY + s * 0.06 + i * s * 0.055;
      ctx.beginPath();
      ctx.moveTo(-w * 0.3, y);
      ctx.lineTo(w * 0.3, y);
      ctx.stroke();
    }
    roundedRect(ctx, -s * 0.16, baseY + s * 0.04, s * 0.32, s * 0.16, s * 0.03);
    ctx.fillStyle = rgba(color, 0.22);
    ctx.fill();
  }

  function drawTabletShape(ctx, s, color) {
    const w = s * 1.34;
    const h = s * 1.72;

    const body = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    body.addColorStop(0, shade(color, 0.42));
    body.addColorStop(0.6, shade(color, -0.16));
    body.addColorStop(1, shade(color, -0.64));
    roundedRect(ctx, -w / 2, -h / 2, w, h, s * 0.16);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.92);
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.stroke();

    const screen = ctx.createLinearGradient(0, -h * 0.36, 0, h * 0.4);
    screen.addColorStop(0, "rgba(4, 11, 19, 0.96)");
    screen.addColorStop(1, rgba(color, 0.26));
    roundedRect(ctx, -w * 0.4, -h * 0.38, w * 0.8, h * 0.76, s * 0.08);
    ctx.fillStyle = screen;
    ctx.fill();

    const tiles = ["#5eead4", "#fbbf24", "#f472b6", "#93c5fd", "#4ade80", "#c4b5fd"];
    for (let i = 0; i < 6; i += 1) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      roundedRect(
        ctx,
        -w * 0.3 + col * w * 0.23,
        -h * 0.28 + row * h * 0.25,
        w * 0.16,
        h * 0.16,
        s * 0.035,
      );
      ctx.fillStyle = rgba(tiles[i], 0.55);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(0, -h * 0.44, Math.max(1.1, s * 0.03), 0, TAU);
    ctx.fillStyle = "rgba(8, 13, 20, 0.9)";
    ctx.fill();
    roundedRect(ctx, -w * 0.16, h * 0.43, w * 0.32, s * 0.035, s * 0.02);
    ctx.fillStyle = rgba(color, 0.6);
    ctx.fill();
  }

  function drawCameraShape(ctx, s, color) {
    roundedRect(ctx, -s * 0.52, s * 0.4, s * 1.04, s * 0.22, s * 0.08);
    ctx.fillStyle = shade(color, -0.62);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.7);
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.stroke();

    const dome = ctx.createRadialGradient(-s * 0.24, -s * 0.05, s * 0.05, 0, s * 0.2, s * 0.8);
    dome.addColorStop(0, shade(color, 0.55));
    dome.addColorStop(0.55, shade(color, -0.12));
    dome.addColorStop(1, shade(color, -0.66));
    ctx.beginPath();
    ctx.arc(0, s * 0.4, s * 0.74, Math.PI, 0);
    ctx.lineTo(s * 0.74, s * 0.46);
    ctx.lineTo(-s * 0.74, s * 0.46);
    ctx.closePath();
    ctx.fillStyle = dome;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, s * 0.16, s * 0.26, 0, TAU);
    ctx.fillStyle = "rgba(6, 11, 18, 0.92)";
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s * 0.05, s * 0.1, s * 0.09, 0, TAU);
    ctx.fillStyle = "rgba(190, 242, 255, 0.9)";
    ctx.fill();

    for (let i = 0; i < 4; i += 1) {
      const angle = Math.PI * 0.25 + (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.arc(
        Math.cos(angle) * s * 0.47,
        s * 0.16 + Math.sin(angle) * s * 0.47,
        Math.max(1, s * 0.032),
        0,
        TAU,
      );
      ctx.fillStyle = rgba("#fda4af", 0.9);
      ctx.fill();
    }
  }

  function drawLightShape(ctx, s, color) {
    const glow = ctx.createRadialGradient(0, -s * 0.2, s * 0.1, 0, -s * 0.2, s * 1.25);
    glow.addColorStop(0, rgba(color, 0.4));
    glow.addColorStop(1, rgba(color, 0));
    ctx.beginPath();
    ctx.arc(0, -s * 0.2, s * 1.25, 0, TAU);
    ctx.fillStyle = glow;
    ctx.fill();

    const glass = ctx.createRadialGradient(-s * 0.2, -s * 0.34, s * 0.06, 0, -s * 0.18, s * 0.62);
    glass.addColorStop(0, "#fffde7");
    glass.addColorStop(0.55, shade(color, 0.35));
    glass.addColorStop(1, shade(color, -0.3));
    ctx.beginPath();
    ctx.arc(0, -s * 0.18, s * 0.6, 0, TAU);
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    ctx.strokeStyle = "rgba(120, 80, 20, 0.55)";
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.beginPath();
    ctx.moveTo(-s * 0.1, -s * 0.08);
    ctx.lineTo(-s * 0.02, -s * 0.3);
    ctx.lineTo(s * 0.06, -s * 0.1);
    ctx.lineTo(s * 0.12, -s * 0.27);
    ctx.stroke();

    roundedRect(ctx, -s * 0.2, s * 0.34, s * 0.4, s * 0.18, s * 0.05);
    ctx.fillStyle = shade(color, -0.42);
    ctx.fill();

    roundedRect(ctx, -s * 0.22, s * 0.5, s * 0.44, s * 0.32, s * 0.06);
    ctx.fillStyle = shade(color, -0.66);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = Math.max(1, s * 0.025);
    for (let i = 0; i < 2; i += 1) {
      const y = s * 0.58 + i * s * 0.1;
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, y);
      ctx.lineTo(s * 0.18, y);
      ctx.stroke();
    }

    ctx.strokeStyle = rgba(color, 0.6);
    ctx.lineWidth = Math.max(1, s * 0.035);
    for (const [dx, dy] of [[-0.52, -0.62], [0.52, -0.62], [0, -0.86]]) {
      ctx.beginPath();
      ctx.moveTo(dx * s * 0.9, dy * s * 0.9);
      ctx.lineTo(dx * s * 1.12, dy * s * 1.12);
      ctx.stroke();
    }
  }

  function drawGamepadShape(ctx, s, color, variant) {
    const grad = ctx.createLinearGradient(0, -s * 0.5, 0, s * 0.65);
    grad.addColorStop(0, shade(color, 0.4));
    grad.addColorStop(1, shade(color, -0.62));
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, -s * 0.34);
    ctx.quadraticCurveTo(-s * 0.98, -s * 0.44, -s * 0.98, s * 0.06);
    ctx.quadraticCurveTo(-s * 1.0, s * 0.56, -s * 0.64, s * 0.58);
    ctx.quadraticCurveTo(-s * 0.34, s * 0.58, -s * 0.16, s * 0.22);
    ctx.lineTo(s * 0.16, s * 0.22);
    ctx.quadraticCurveTo(s * 0.34, s * 0.58, s * 0.64, s * 0.58);
    ctx.quadraticCurveTo(s * 1.0, s * 0.56, s * 0.98, s * 0.06);
    ctx.quadraticCurveTo(s * 0.98, -s * 0.44, s * 0.5, -s * 0.34);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    // Left analog stick and D-pad.
    ctx.beginPath();
    ctx.arc(-s * 0.5, s * 0.1, s * 0.17, 0, TAU);
    ctx.fillStyle = "rgba(6, 11, 18, 0.88)";
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-s * 0.5, s * 0.1, s * 0.06, 0, TAU);
    ctx.fillStyle = rgba(color, 0.7);
    ctx.fill();

    ctx.strokeStyle = rgba(color, 0.8);
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.beginPath();
    ctx.moveTo(-s * 0.24, s * 0.06);
    ctx.lineTo(-s * 0.06, s * 0.06);
    ctx.moveTo(-s * 0.15, -s * 0.04);
    ctx.lineTo(-s * 0.15, s * 0.16);
    ctx.stroke();

    // Right-side face buttons.
    const bx = s * 0.52;
    const by = s * 0.1;
    const spread = s * 0.13;
    if (variant === "playstation") {
      ctx.strokeStyle = "rgba(226, 240, 255, 0.95)";
      ctx.lineWidth = Math.max(1, s * 0.028);
      ctx.beginPath();
      ctx.moveTo(bx, by - spread - s * 0.045);
      ctx.lineTo(bx + s * 0.045, by - spread + s * 0.035);
      ctx.lineTo(bx - s * 0.045, by - spread + s * 0.035);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx + spread, by, s * 0.042, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - s * 0.04, by + spread - s * 0.04);
      ctx.lineTo(bx + s * 0.04, by + spread + s * 0.04);
      ctx.moveTo(bx + s * 0.04, by + spread - s * 0.04);
      ctx.lineTo(bx - s * 0.04, by + spread + s * 0.04);
      ctx.stroke();
      ctx.strokeRect(bx - spread - s * 0.035, by - s * 0.035, s * 0.07, s * 0.07);
    } else {
      const dots = ["#4ade80", "#f87171", "#60a5fa", "#fbbf24"];
      const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (let i = 0; i < 4; i += 1) {
        const [ox, oy] = offsets[i];
        ctx.beginPath();
        ctx.arc(bx + ox * spread, by + oy * spread, Math.max(1.2, s * 0.048), 0, TAU);
        ctx.fillStyle = dots[i];
        ctx.fill();
      }
    }

    if (variant === "xbox") {
      ctx.beginPath();
      ctx.arc(0, -s * 0.13, s * 0.13, 0, TAU);
      ctx.fillStyle = "rgba(6, 15, 10, 0.75)";
      ctx.fill();
      ctx.strokeStyle = "rgba(220, 255, 235, 0.9)";
      ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.05, -s * 0.18);
      ctx.lineTo(s * 0.05, -s * 0.08);
      ctx.moveTo(s * 0.05, -s * 0.18);
      ctx.lineTo(-s * 0.05, -s * 0.08);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, -s * 0.13, s * 0.05, 0, TAU);
      ctx.fillStyle = rgba("#e2f0ff", 0.5);
      ctx.fill();
    }
  }

  function drawSpeakerShape(ctx, s, color) {
    const w = s * 1.0;
    const h = s * 1.5;

    const body = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    body.addColorStop(0, shade(color, -0.42));
    body.addColorStop(0.45, shade(color, 0.3));
    body.addColorStop(1, shade(color, -0.6));
    roundedRect(ctx, -w / 2, -h / 2, w, h, w * 0.42);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    const mesh = ctx.createLinearGradient(0, -h * 0.16, 0, h * 0.42);
    mesh.addColorStop(0, "rgba(8, 13, 20, 0.85)");
    mesh.addColorStop(1, rgba(color, 0.18));
    roundedRect(ctx, -w * 0.34, -h * 0.14, w * 0.68, h * 0.5, s * 0.12);
    ctx.fillStyle = mesh;
    ctx.fill();

    ctx.fillStyle = rgba(color, 0.42);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        ctx.beginPath();
        ctx.arc(
          -w * 0.2 + col * w * 0.2,
          -h * 0.04 + row * h * 0.11,
          Math.max(0.9, s * 0.022),
          0,
          TAU,
        );
        ctx.fill();
      }
    }

    ctx.beginPath();
    ctx.ellipse(0, -h * 0.44, w * 0.3, s * 0.07, 0, 0, TAU);
    ctx.fillStyle = rgba(color, 0.35);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, h * 0.42, Math.max(1.3, s * 0.055), 0, TAU);
    ctx.fillStyle = "#5eead4";
    ctx.fill();
  }

  function drawPhoneShape(ctx, s, color) {
    const w = s * 0.92;
    const h = s * 1.66;

    const body = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    body.addColorStop(0, shade(color, 0.4));
    body.addColorStop(0.6, shade(color, -0.15));
    body.addColorStop(1, shade(color, -0.66));
    roundedRect(ctx, -w / 2, -h / 2, w, h, s * 0.2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.92);
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.stroke();

    const screen = ctx.createLinearGradient(0, -h * 0.36, 0, h * 0.36);
    screen.addColorStop(0, "rgba(4, 11, 19, 0.96)");
    screen.addColorStop(1, rgba(color, 0.3));
    roundedRect(ctx, -w * 0.39, -h * 0.36, w * 0.78, h * 0.72, s * 0.12);
    ctx.fillStyle = screen;
    ctx.fill();

    roundedRect(ctx, -w * 0.16, -h * 0.43, w * 0.32, s * 0.08, s * 0.04);
    ctx.fillStyle = rgba(color, 0.55);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, h * 0.42, Math.max(1.4, s * 0.055), 0, TAU);
    ctx.fillStyle = rgba(color, 0.75);
    ctx.fill();
  }

  function drawTvShape(ctx, s, color) {
    const w = s * 1.86;
    const h = s * 1.08;

    ctx.strokeStyle = rgba(color, 0.7);
    ctx.lineWidth = Math.max(1.4, s * 0.055);
    ctx.beginPath();
    ctx.moveTo(-w * 0.2, h * 0.48);
    ctx.lineTo(-w * 0.26, h * 0.78);
    ctx.moveTo(w * 0.2, h * 0.48);
    ctx.lineTo(w * 0.26, h * 0.78);
    ctx.stroke();
    roundedRect(ctx, -w * 0.3, h * 0.74, w * 0.6, s * 0.13, s * 0.05);
    ctx.fillStyle = shade(color, -0.55);
    ctx.fill();

    const frame = ctx.createLinearGradient(0, -h * 0.52, 0, h * 0.5);
    frame.addColorStop(0, shade(color, 0.38));
    frame.addColorStop(1, shade(color, -0.64));
    roundedRect(ctx, -w / 2, -h * 0.52, w, h, s * 0.1);
    ctx.fillStyle = frame;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    const screen = ctx.createLinearGradient(0, -h * 0.4, 0, h * 0.32);
    screen.addColorStop(0, "rgba(4, 10, 18, 0.96)");
    screen.addColorStop(0.65, rgba(color, 0.18));
    screen.addColorStop(1, rgba(color, 0.42));
    roundedRect(ctx, -w * 0.45, -h * 0.42, w * 0.9, h * 0.72, s * 0.05);
    ctx.fillStyle = screen;
    ctx.fill();

    ctx.fillStyle = rgba(color, 0.9);
    ctx.beginPath();
    ctx.moveTo(-s * 0.1, -s * 0.16);
    ctx.lineTo(s * 0.22, 0);
    ctx.lineTo(-s * 0.1, s * 0.16);
    ctx.closePath();
    ctx.fill();
  }

  function drawIotShape(ctx, s, color) {
    const radius = s * 0.82;

    const core = ctx.createRadialGradient(-radius * 0.32, -radius * 0.36, radius * 0.1, 0, 0, radius);
    core.addColorStop(0, shade(color, 0.6));
    core.addColorStop(0.55, color);
    core.addColorStop(1, shade(color, -0.6));
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fillStyle = core;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    ctx.strokeStyle = rgba(color, 0.32);
    ctx.lineWidth = Math.max(1, s * 0.028);
    for (let i = -2; i <= 2; i += 1) {
      const y = (i / 2) * radius * 0.72;
      const rx = Math.sqrt(Math.max(0, 1 - (y / radius) ** 2)) * radius;
      ctx.beginPath();
      ctx.ellipse(0, y, rx, Math.max(1.5, radius * 0.13), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.36, radius, 0, 0, TAU);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(radius * 0.55, -radius * 0.42, Math.max(1.6, s * 0.07), 0, TAU);
    ctx.fillStyle = "#fff7d6";
    ctx.fill();
  }

  function drawPrinterShape(ctx, s, color) {
    const w = s * 1.52;
    const h = s * 0.86;

    roundedRect(ctx, -w * 0.3, -h * 1.32, w * 0.6, h * 0.72, s * 0.04);
    ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.5);
    ctx.lineWidth = Math.max(1, s * 0.025);
    ctx.stroke();

    const body = ctx.createLinearGradient(0, -h * 0.45, 0, h * 0.45);
    body.addColorStop(0, shade(color, 0.34));
    body.addColorStop(1, shade(color, -0.6));
    roundedRect(ctx, -w / 2, -h * 0.45, w, h * 0.9, s * 0.12);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.stroke();

    roundedRect(ctx, -w * 0.38, -h * 0.12, w * 0.76, h * 0.2, s * 0.04);
    ctx.fillStyle = "rgba(5, 11, 18, 0.85)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(w * 0.34, -h * 0.24, Math.max(1.4, s * 0.055), 0, TAU);
    ctx.fillStyle = "#5eead4";
    ctx.fill();
  }

  function drawCubeShape(ctx, s, color) {
    const r = s * 0.9;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.9, r * 0.5);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.9, r * 0.5);
    ctx.lineTo(-r * 0.9, -r * 0.45);
    ctx.closePath();
    ctx.fillStyle = shade(color, -0.28);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = Math.max(1, s * 0.045);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.9, -r * 0.45);
    ctx.lineTo(0, -r * 0.05);
    ctx.lineTo(-r * 0.9, -r * 0.45);
    ctx.closePath();
    ctx.fillStyle = shade(color, 0.24);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, -r * 0.05);
    ctx.lineTo(r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.9, r * 0.5);
    ctx.lineTo(0, r);
    ctx.closePath();
    ctx.fillStyle = shade(color, -0.55);
    ctx.fill();
  }

  function drawDeviceShape(ctx, device, s, color) {
    if (device.is_gateway) return drawRouterShape(ctx, s, color);
    switch (device.type) {
      case "phone": return drawPhoneShape(ctx, s, color);
      case "tablet": return drawTabletShape(ctx, s, color);
      case "laptop": return drawLaptopShape(ctx, s, color);
      case "tv": return drawTvShape(ctx, s, color);
      case "camera": return drawCameraShape(ctx, s, color);
      case "light": return drawLightShape(ctx, s, color);
      case "speaker": return drawSpeakerShape(ctx, s, color);
      case "xbox": return drawGamepadShape(ctx, s, color, "xbox");
      case "playstation": return drawGamepadShape(ctx, s, color, "playstation");
      case "console": return drawGamepadShape(ctx, s, color, "console");
      case "iot": return drawIotShape(ctx, s, color);
      case "printer": return drawPrinterShape(ctx, s, color);
      case "computer": return drawComputerShape(ctx, s, color);
      default: return drawCubeShape(ctx, s, color);
    }
  }

  function drawBlockedBadge(ctx, s) {
    const x = s * 0.78;
    const y = -s * 0.78;
    const r = Math.max(6, s * 0.26);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = "rgba(12, 8, 10, 0.92)";
    ctx.fill();
    ctx.strokeStyle = BLOCK_COLOR;
    ctx.lineWidth = Math.max(1.2, s * 0.05);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.52, y + r * 0.52);
    ctx.lineTo(x + r * 0.52, y - r * 0.52);
    ctx.stroke();
  }

  // ------------------------------------------------------------------ scene
  function create(options) {
    const canvas = options.canvas;
    const ctx = canvas.getContext("2d");
    const onSelect = options.onSelect || (() => {});
    const onLinkAction = options.onLinkAction || (() => {});
    const onHover = options.onHover || (() => {});

    let width = 0;
    let height = 0;
    let dpr = 1;
    let camera = null;
    let running = false;
    let rafId = 0;
    let lastTime = 0;
    let elapsed = 0;
    let autoRotate = false;
    let layout = options.layout === "tree" ? "tree" : "orbit";

    const ORBIT_HOME = { yaw: -0.66, pitch: 0.5 };
    const TREE_HOME = { yaw: 0, pitch: 0.16 };
    const cam = {
      yaw: layout === "tree" ? TREE_HOME.yaw : ORBIT_HOME.yaw,
      pitch: layout === "tree" ? TREE_HOME.pitch : ORBIT_HOME.pitch,
      dist: 27,
      goalDist: 27,
      target: vec(0, 1.05, 0),
      goalTarget: vec(0, 1.05, 0),
    };

    let routerNode = null;
    let nodes = [];
    let deviceList = [];
    let routerInfo = {};
    let networkInfo = {};
    let canControl = false;
    let canWifi = false;
    let iconScale = 1;
    let selectedKey = "";
    let focusTypes = [];
    let themeName = "dark";
    let palette = SCENE_PALETTES.dark;
    let hoverHit = null;
    const nodeHits = [];
    const linkHits = [];
    const labelQueue = [];
    const labelRects = [];
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let lastDragSample = null;
    const orbitInertia = { yaw: 0, pitch: 0 };
    let needsFit = true;
    let userAdjusted = false;
    let lastSatelliteCount = -1;

    // -- layout ----------------------------------------------------------
    function treeMetrics(total) {
      const count = Math.max(1, total);
      const cols = clamp(
        Math.min(count, Math.ceil(Math.sqrt(count * 1.6))), 1, TREE_MAX_COLS,
      );
      return { cols, rows: Math.ceil(count / cols) };
    }

    function treeRowY(row) {
      return TREE_FIRST_ROW - row * TREE_ROW_GAP;
    }

    function treeSlot(index, total) {
      const { cols } = treeMetrics(total);
      const row = Math.floor(index / cols);
      const rowStart = row * cols;
      const rowCount = Math.max(1, Math.min(cols, total - rowStart));
      // A short last row is centred under the grid instead of hanging left.
      const col = (index % cols) + (cols - rowCount) / 2;
      return vec((col - (cols - 1) / 2) * TREE_COL_GAP, treeRowY(row), 0);
    }

    function treeCenterY(total) {
      if (!total) return TREE_FIRST_ROW;
      const { rows } = treeMetrics(total);
      return (TREE_TOP + treeRowY(rows - 1)) / 2;
    }

    function routerTarget() {
      return layout === "tree" ? vec(0, TREE_TOP, 0) : vec(0, ROUTER_Y, 0);
    }

    function viewTarget() {
      return layout === "tree"
        ? vec(0, treeCenterY(nodes.length), 0)
        : vec(0, 0.95, 0);
    }

    function slotPosition(index, total) {
      const caps = [8, 12, 16, 20];
      let ring = 0;
      let offset = 0;
      while (ring < caps.length - 1 && index >= offset + caps[ring]) {
        offset += caps[ring];
        ring += 1;
      }
      const inRing = index - offset;
      const count = Math.max(1, Math.min(caps[ring], total - offset));
      const radius = 9.2 + ring * 5.2;
      const base = -Math.PI / 2 + 0.55;
      let angle;

      if (ring === 0) {
        angle = base + (inRing / count) * TAU;
      } else {
        // Outer rings sit in the angular gaps of the ring inside them, so
        // their links never run along an inner link or through an inner node.
        const innerSlots = ring === 1 ? 8 : 12;
        const phase = ring === 1 ? base : base + TAU / 16;
        if (count <= innerSlots) {
          const slot = Math.floor((inRing * innerSlots) / count);
          angle = phase + ((slot + 0.5) / innerSlots) * TAU;
        } else {
          angle = phase + TAU / (2 * innerSlots) + (inRing / count) * TAU;
        }
      }

      return vec(
        Math.cos(angle) * radius,
        0.3 + ((index * 7) % 5) * 0.34 + ring * 0.3,
        Math.sin(angle) * radius,
      );
    }

    function makeRouterNode() {
      const gateway = deviceList.find((device) => device.is_gateway);
      const device = gateway || {
        ip: routerInfo.host || networkInfo.gateway || "",
        mac: "",
        name: routerInfo.model || "Router",
        vendor: "",
        type: "router",
        online: true,
        state: "router",
        is_gateway: true,
        is_self: false,
        blocked: false,
        wifi_blocked: false,
        connection: "lan",
        source: "router",
      };
      const start = routerTarget();
      return {
        key: gateway ? nodeKey(gateway) : "__router__",
        device,
        pos: vec(start.x, start.y, start.z),
        target: vec(start.x, start.y, start.z),
        animated: vec(start.x, start.y, start.z),
        phase: 0,
        size: 1.9 * iconScale,
        isRouter: true,
        slot: -1,
      };
    }

    function sync(payload) {
      routerInfo = payload.router || {};
      networkInfo = payload.network || {};
      canControl = !!payload.canControl;
      canWifi = !!payload.canWifi;
      deviceList = payload.devices || [];
      focusTypes = Array.isArray(payload.focusTypes) ? payload.focusTypes.slice() : [];
      themeName = payload.theme === "light" ? "light" : "dark";
      palette = SCENE_PALETTES[themeName];
      const requestedScale = Number(payload.iconScale);
      iconScale = Number.isFinite(requestedScale) ? clamp(requestedScale, 0.4, 1) : 1;
      const hideOffline = !!payload.hideOffline;

      // Keep the existing router node so a layout switch animates instead of
      // snapping when the next refresh lands.
      const routed = makeRouterNode();
      if (routerNode) {
        routerNode.key = routed.key;
        routerNode.device = routed.device;
        routerNode.target = routed.target;
        routerNode.size = routed.size;
      } else {
        routerNode = routed;
      }

      const satellites = deviceList.filter((device) => (
        !device.is_gateway && (!hideOffline || device.online !== false)
      ));
      const alive = new Set();
      satellites.forEach((device, index) => {
        const key = nodeKey(device);
        alive.add(key);
        const target = layout === "tree"
          ? treeSlot(index, satellites.length)
          : slotPosition(index, satellites.length);
        let node = nodes.find((item) => item.key === key);
        if (!node) {
          node = {
            key,
            device,
            pos: vec(0.5, ROUTER_Y, 0.5),
            target,
            animated: vec(0.5, ROUTER_Y, 0.5),
            phase: (index * 1.7) % TAU,
            size: (device.is_self ? 1.2 : 1.05) * iconScale,
            isRouter: false,
            slot: index,
          };
          nodes.push(node);
        }
        node.device = device;
        node.target = target;
        node.slot = index;
        node.size = (device.is_self ? 1.2 : 1.05) * iconScale;
      });
      nodes = nodes.filter((node) => alive.has(node.key));
      if (satellites.length !== lastSatelliteCount) {
        lastSatelliteCount = satellites.length;
        needsFit = true;
      }

      if (selectedKey && selectedKey !== routerNode.key
        && !nodes.some((node) => node.key === selectedKey)) {
        selectedKey = "";
      }
    }

    // -- camera ----------------------------------------------------------
    function cameraAt(dist, yaw, pitch, target) {
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);
      const eye = {
        x: target.x + dist * Math.sin(yaw) * cosPitch,
        y: target.y + dist * sinPitch,
        z: target.z + dist * Math.cos(yaw) * cosPitch,
      };
      const forward = norm(sub(target, eye));
      let upRef = vec(0, 1, 0);
      if (Math.abs(dot(forward, upRef)) > 0.999) upRef = vec(0, 0, 1);
      const right = norm(cross(forward, upRef));
      const up = cross(right, forward);
      return {
        eye,
        forward,
        right,
        up,
        focal: (height / 2) / Math.tan((FOV_DEG * Math.PI / 180) / 2),
        cx: width / 2,
        cy: height * 0.45,
      };
    }

    function computeCamera() {
      return cameraAt(cam.dist, cam.yaw, cam.pitch, cam.target);
    }

    function projectWith(viewCamera, point) {
      if (!viewCamera) return null;
      const dx = point.x - viewCamera.eye.x;
      const dy = point.y - viewCamera.eye.y;
      const dz = point.z - viewCamera.eye.z;
      const depth = dx * viewCamera.forward.x
        + dy * viewCamera.forward.y
        + dz * viewCamera.forward.z;
      if (depth < 0.6) return null;
      const scale = viewCamera.focal / depth;
      return {
        x: viewCamera.cx
          + (dx * viewCamera.right.x + dy * viewCamera.right.y + dz * viewCamera.right.z) * scale,
        y: viewCamera.cy
          - (dx * viewCamera.up.x + dy * viewCamera.up.y + dz * viewCamera.up.z) * scale,
        scale,
        depth,
      };
    }

    function project(point) {
      return projectWith(camera, point);
    }

    /* Pick the closest camera distance that keeps every device inside the
     * viewport while leaving room for the HUD, the shape and its label. */
    function fitDistance() {
      if (!width || !height || !routerNode) return cam.dist;
      const points = [{
        position: routerNode.target, size: routerNode.size, labeled: true,
      }];
      for (const node of nodes) {
        points.push({
          position: node.target,
          size: node.size,
          labeled: node.device.online !== false,
        });      }
      const target = viewTarget();
      const marginX = clamp(width * 0.07, 38, 96);
      const marginTop = 62;
      const marginBottom = 26;
      if (points.length === 1) return 22;
      const fits = (dist) => {
        const viewCamera = cameraAt(dist, cam.yaw, cam.pitch, target);
        return points.every(({ position, size, labeled }) => {
          const projected = projectWith(viewCamera, position);
          if (!projected) return false;
          const radius = size * projected.scale;
          const labelPad = labeled ? 38 : 24;
          return projected.x - radius * 1.15 > marginX
            && projected.x + radius * 1.15 < width - marginX
            && projected.y - radius * 1.35 > marginTop
            && projected.y + radius * 1.3 + labelPad < height - marginBottom;
        });
      };
      if (fits(MIN_DIST)) return MIN_DIST;
      let low = MIN_DIST;
      let high = MAX_DIST;
      for (let i = 0; i < 20; i += 1) {
        const middle = (low + high) / 2;
        if (fits(middle)) high = middle;
        else low = middle;
      }
      return high;
    }

    function applyFit() {
      const distance = fitDistance();
      const target = viewTarget();
      cam.goalDist = distance;
      cam.dist = distance;
      cam.target = vec(target.x, target.y, target.z);
      cam.goalTarget = vec(target.x, target.y, target.z);
    }

    function retargetLayout() {
      if (routerNode) routerNode.target = routerTarget();
      for (const node of nodes) {
        node.target = layout === "tree"
          ? treeSlot(node.slot, nodes.length)
          : slotPosition(node.slot, nodes.length);
      }
    }

    function setLayout(name) {
      layout = name === "tree" ? "tree" : "orbit";
      const angles = layout === "tree" ? TREE_HOME : ORBIT_HOME;
      cam.yaw = angles.yaw;
      cam.pitch = angles.pitch;
      userAdjusted = false;
      hoverHit = null;
      onHover(null);
      retargetLayout();
      needsFit = true;
      applyFit();
      if (!running) draw();
    }

    function curvePoint(a, c, b, t) {
      const it = 1 - t;
      return vec(
        it * it * a.x + 2 * it * t * c.x + t * t * b.x,
        it * it * a.y + 2 * it * t * c.y + t * t * b.y,
        it * it * a.z + 2 * it * t * c.z + t * t * b.z,
      );
    }

    function animatePositions(dt) {
      const k = 1 - Math.exp(-dt * 5.2);
      const apply = (node) => {
        node.pos.x = lerp(node.pos.x, node.target.x, k);
        node.pos.y = lerp(node.pos.y, node.target.y, k);
        node.pos.z = lerp(node.pos.z, node.target.z, k);
        const bob = REDUCED_MOTION ? 0 : Math.sin(elapsed * 1.15 + node.phase) * 0.09;
        node.animated = vec(node.pos.x, node.pos.y + bob, node.pos.z);
      };
      if (routerNode) {
        apply(routerNode);
        const bob = REDUCED_MOTION ? 0 : Math.sin(elapsed * 0.9) * 0.05;
        routerNode.animated.y = routerNode.pos.y + bob;
      }
      for (const node of nodes) apply(node);
    }

    // -- drawing ---------------------------------------------------------
    /* The tree hangs in mid-air, so it gets a faint graph-paper plane behind
     * it instead of the orbiting floor rings. */
    function drawTreeBackdrop() {
      const { cols, rows } = treeMetrics(nodes.length);
      const halfW = Math.max(6, ((cols - 1) / 2) * TREE_COL_GAP + 2.6);
      const top = TREE_TOP + 2.2;
      const bottom = treeRowY(rows - 1) - 2.4;
      const z = -2.6;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.grid;
      for (let x = -halfW; x <= halfW + 0.01; x += 2) {
        const a = project(vec(x, top, z));
        const b = project(vec(x, bottom, z));
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let y = bottom; y <= top + 0.01; y += 2) {
        const a = project(vec(-halfW, y, z));
        const b = project(vec(halfW, y, z));
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawFloor() {
      ctx.save();
      ctx.lineWidth = 1;
      const extent = 21;
      const step = 2.6;
      for (let i = -extent; i <= extent + 0.01; i += step) {
        const lines = [
          [vec(i, FLOOR_Y, -extent), vec(i, FLOOR_Y, extent)],
          [vec(-extent, FLOOR_Y, i), vec(extent, FLOOR_Y, i)],
        ];
        for (const [a, b] of lines) {
          const pa = project(a);
          const pb = project(b);
          if (!pa || !pb) continue;
          ctx.strokeStyle = palette.grid;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }

      for (const radius of [5.2, 10.2, 15.4]) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= 96; i += 1) {
          const angle = (i / 96) * TAU;
          const point = project({
            x: Math.cos(angle) * radius,
            y: FLOOR_Y,
            z: Math.sin(angle) * radius,
          });
          if (!point) {
            started = false;
            continue;
          }
          if (!started) {
            ctx.moveTo(point.x, point.y);
            started = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.strokeStyle = radius === 5.2 ? palette.ring : palette.ringSoft;
        ctx.stroke();
      }

      const center = project(vec(0, FLOOR_Y, 0));
      if (center) {
        const rx = 4.6 * center.scale;
        const ry = Math.max(2, rx * Math.max(0.16, Math.sin(cam.pitch)));
        const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, rx);
        glow.addColorStop(0, palette.floorGlow);
        glow.addColorStop(0.55, palette.floorGlowSoft);
        glow.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.scale(1, ry / rx);
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, TAU);
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    function drawShadow(node) {
      const base = project(vec(node.animated.x, FLOOR_Y, node.animated.z));
      if (!base) return;
      const lift = clamp(1 - (node.animated.y - FLOOR_Y) / 7, 0.14, 1);
      const rx = node.size * base.scale * 1.05 * lift;
      const ry = Math.max(1.5, rx * Math.max(0.12, Math.sin(cam.pitch)) * 0.85);
      ctx.save();
      ctx.globalAlpha = node.device.online === false ? 0.4 : 1;
      ctx.fillStyle = palette.shadow;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, rx, ry, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    function isFocused(device) {
      if (!focusTypes.length) return true;
      const type = device.is_gateway ? "router" : (device.type || "other");
      return focusTypes.includes(type);
    }

    function pointOnPolyline(points, t) {
      if (!points.length) return null;
      if (points.length === 1) return points[0];
      const lengths = [];
      let total = 0;
      for (let i = 1; i < points.length; i += 1) {
        const length = Math.hypot(
          points[i].x - points[i - 1].x, points[i].y - points[i - 1].y,
        );
        lengths.push(length);
        total += length;
      }
      if (!total) return points[0];
      let remaining = clamp(t, 0, 1) * total;
      for (let i = 1; i < points.length; i += 1) {
        const length = lengths[i - 1];
        if (remaining <= length) {
          const local = length ? remaining / length : 0;
          return {
            x: lerp(points[i - 1].x, points[i].x, local),
            y: lerp(points[i - 1].y, points[i].y, local),
          };
        }
        remaining -= length;
      }
      return points[points.length - 1];
    }

    /* Tree layout: every device gets its own elbow path from the router. The
     * paths are offset into parallel lanes (x for the vertical run, y within
     * the row for the horizontal run) so no two branch lines ever sit on top
     * of one another. */
    function treeBranches() {
      const { cols } = treeMetrics(nodes.length);
      const total = nodes.length;
      const ordered = [...nodes].sort((a, b) => a.target.x - b.target.x);
      const laneOf = new Map(ordered.map((node, index) => [node, index]));

      const rows = new Map();
      for (const node of nodes) {
        const row = Math.floor(node.slot / cols);
        if (!rows.has(row)) rows.set(row, []);
        rows.get(row).push(node);
      }

      const branches = [];
      for (const [row, rowNodes] of rows) {
        const inRow = [...rowNodes].sort((a, b) => a.target.x - b.target.x);
        inRow.forEach((node, index) => {
          const lane = (laneOf.get(node) - (total - 1) / 2) * TREE_LANE_X;
          const armY = treeRowY(row) + TREE_ARM_LIFT
            + (index - (inRow.length - 1) / 2) * TREE_LANE_Y;
          branches.push({ node, row, lane, armY });
        });
      }
      return branches;
    }

    function drawTreeLinks() {
      if (!routerNode) return;
      const branches = treeBranches();
      if (!branches.length) return;

      const root = routerNode.animated;
      const trunkTop = root.y - 0.95;

      for (const branch of branches) {
        const { node, lane, armY } = branch;
        const style = styleFor(node.device, themeName);
        const blocked = !!node.device.blocked;
        const offline = node.device.online === false;
        const hovered = hoverHit && hoverHit.type === "link" && hoverHit.key === node.key;
        const selected = node.key === selectedKey;
        const emphasized = isFocused(node.device) || hovered || selected;
        const color = emphasized ? (blocked ? BLOCK_COLOR : style.color) : palette.dim;

        const a = project(vec(lane, trunkTop, 0));
        const b = project(vec(lane, armY, 0));
        const c = project(vec(node.animated.x, armY, 0));
        const d = project(vec(node.animated.x, node.animated.y, 0));
        if (!a || !b || !c || !d) continue;

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // The cable stays neutral and solid until its branch is active; only
        // the final drop carries the device colour and state.
        ctx.setLineDash([]);
        ctx.lineWidth = hovered || selected ? 2.2 : 1.2;
        ctx.strokeStyle = rgba(color, emphasized ? (hovered || selected ? 0.6 : 0.3) : 0.1);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();

        ctx.lineWidth = hovered || selected ? 2.4 : 1.6;
        ctx.strokeStyle = rgba(
          color, emphasized ? (offline ? 0.28 : (hovered || selected ? 0.85 : 0.6)) : 0.14,
        );
        if (!REDUCED_MOTION && (blocked || offline)) {
          ctx.setLineDash(blocked ? [3, 7] : [4, 8]);
          ctx.lineDashOffset = -((elapsed * 16 + node.phase * 6) % 13);
        }
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
        ctx.restore();

        // A junction dot marks where the branch leaves its lane.
        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(1.6, Math.min(3, c.scale / 26)), 0, TAU);
        ctx.fillStyle = rgba(color, emphasized ? 0.85 : 0.4);
        ctx.fill();

        if (emphasized && !blocked && !offline && !REDUCED_MOTION
          && (hovered || selected)) {
          const path = [a, b, c, d];
          for (let i = 0; i < 2; i += 1) {
            const t = (elapsed * 0.22 + node.phase * 0.11 + i / 2) % 1;
            const point = pointOnPolyline(path, t);
            if (!point) continue;
            const fade = Math.sin(t * Math.PI);
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2.4, 0, TAU);
            ctx.fillStyle = rgba(color, 0.85 * fade);
            ctx.fill();
          }
        }

        const points = [];
        for (let i = 0; i <= 24; i += 1) {
          const point = pointOnPolyline([a, b, c, d], i / 24);
          if (point) points.push(point);
        }
        linkHits.push({
          type: "link",
          key: node.key,
          node,
          points,
          mid: { x: c.x, y: c.y },
          color,
          blocked,
        });
      }
    }

    function drawLinks() {
      if (!routerNode) return;
      if (layout === "tree") {
        drawTreeLinks();
        return;
      }
      for (const node of nodes) {
        const a = routerNode.animated;
        const b = node.animated;
        const distance = Math.hypot(b.x - a.x, b.z - a.z);
        const control = vec(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 + 0.7 + distance * 0.11,
          (a.z + b.z) / 2,
        );
        const pa = project(a);
        const pb = project(b);
        const pc = project(control);
        if (!pa || !pb || !pc) continue;

        const style = styleFor(node.device, themeName);
        const blocked = !!node.device.blocked;
        const offline = node.device.online === false;
        const hovered = hoverHit && hoverHit.type === "link" && hoverHit.key === node.key;
        const selected = node.key === selectedKey;
        const emphasized = isFocused(node.device) || hovered || selected;
        const color = emphasized ? (blocked ? BLOCK_COLOR : style.color) : palette.dim;

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineWidth = emphasized ? (hovered || selected ? 2.2 : 1.35) : 1;
        ctx.strokeStyle = rgba(
          color,
          emphasized ? (offline ? 0.2 : (hovered || selected ? 0.8 : 0.46)) : 0.1,
        );
        if (!REDUCED_MOTION && (blocked || offline)) {
          ctx.setLineDash(blocked ? [3, 7] : [4, 8]);
          ctx.lineDashOffset = -((elapsed * 16 + node.phase * 6) % 13);
        } else {
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.quadraticCurveTo(pc.x, pc.y, pb.x, pb.y);
        ctx.stroke();

        if (emphasized && (hovered || selected)) {
          ctx.lineWidth = 5;
          ctx.strokeStyle = rgba(color, 0.12);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.quadraticCurveTo(pc.x, pc.y, pb.x, pb.y);
          ctx.stroke();
        }

        if (emphasized && !blocked && !offline && !REDUCED_MOTION) {
          for (let i = 0; i < 3; i += 1) {
            const t = ((elapsed * 0.19 + node.phase * 0.12 + i / 3) % 1);
            const point = curvePoint(a, control, b, t);
            const pp = project(point);
            if (!pp) continue;
            const fade = Math.sin(t * Math.PI);
            ctx.beginPath();
            ctx.arc(pp.x, pp.y, Math.max(1.1, 2.3 * Math.min(1.4, pp.scale / 20)), 0, TAU);
            ctx.fillStyle = rgba(color, 0.85 * fade);
            ctx.fill();
          }
        }

        const middle = curvePoint(a, control, b, 0.5);
        const pm = project(middle);

        // Sample the same screen-space curve we draw so the whole line is a
        // hit target, not just a button at its midpoint.
        const points = [];
        for (let i = 0; i <= 20; i += 1) {
          const t = i / 20;
          const it = 1 - t;
          points.push({
            x: it * it * pa.x + 2 * it * t * pc.x + t * t * pb.x,
            y: it * it * pa.y + 2 * it * t * pc.y + t * t * pb.y,
          });
        }
        linkHits.push({
          type: "link",
          key: node.key,
          node,
          points,
          mid: pm ? { x: pm.x, y: pm.y } : points[10],
          color,
          blocked,
        });
        ctx.restore();
      }

      // A soft beam anchoring the router to the floor keeps the hub readable.
      const top = project(vec(routerNode.animated.x, routerNode.animated.y, routerNode.animated.z));
      const bottom = project(vec(routerNode.animated.x, FLOOR_Y, routerNode.animated.z));
      if (top && bottom) {
        const beam = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
        beam.addColorStop(0, palette.beam);
        beam.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.strokeStyle = beam;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bottom.x, bottom.y);
        ctx.stroke();
      }
    }

    function drawPlugGlyph(x, y, color, enabled, hovered) {
      const scale = hovered ? 1.18 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = enabled ? 1 : 0.5;
      if (hovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
      }

      roundedRect(ctx, -4.6, -1.6, 9.2, 7.2, 2.2);
      ctx.fillStyle = palette.plugBg;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      const strokeParts = (width, tint) => {
        ctx.strokeStyle = tint;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(-2.4, -1.6);
        ctx.lineTo(-2.4, -5.6);
        ctx.moveTo(2.4, -1.6);
        ctx.lineTo(2.4, -5.6);
        ctx.moveTo(0, 5.6);
        ctx.lineTo(0, 8.2);
        ctx.stroke();
      };
      strokeParts(4.6, palette.plugBg);
      strokeParts(1.8, color);
      ctx.restore();
    }

    function drawLinkIndicators() {
      for (const hit of linkHits) {
        if (!hit.blocked) continue;
        const device = hit.node.device;
        const hovered = hoverHit && hoverHit.type === "link" && hoverHit.key === hit.key;
        const selected = hit.key === selectedKey;
        if (focusTypes.length && !isFocused(device) && !hovered && !selected) continue;
        const enabled = canControl
          && device.online !== false
          && !device.is_self
          && !device.is_gateway;
        drawPlugGlyph(hit.mid.x, hit.mid.y, enabled ? palette.reconnect : palette.dim, enabled, hovered);
      }
    }

    function drawLabel(node, point, s, color, online, active, compact) {
      const device = node.device;
      const raw = device.label || device.name || device.vendor
        || device.ip || (node.isRouter ? "Router" : "Device");
      const name = raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
      const sub = compact
        ? ""
        : (device.is_gateway
          ? (routerInfo.model && routerInfo.model !== name ? routerInfo.model : "Gateway")
          : (device.ip || "no address"));

      ctx.save();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `600 11.5px ${FONT}`;
      const nameWidth = ctx.measureText(name).width;
      ctx.font = `10px ${MONO}`;
      const subWidth = sub ? ctx.measureText(sub).width : 0;
      const boxW = Math.min(180, Math.max(nameWidth, subWidth) + 26);
      const boxH = compact ? 21 : 34;
      // In tree view the router label sits above the shape so it never covers
      // the branch cables leaving the router.
      const above = layout === "tree" && node.isRouter;
      const y = above
        ? point.y - s * 1.0 - 7 - boxH
        : point.y + s * 1.0 + 7;
      const boxX = clamp(point.x - boxW / 2, 8, Math.max(8, width - boxW - 8));
      const boxY = clamp(y, 8, Math.max(8, height - boxH - 8));

      const rect = { x: boxX - 4, y: boxY - 4, w: boxW + 8, h: boxH + 8 };
      if (!active) {
        const blockedBy = labelRects.some((other) => (
          rect.x < other.x + other.w
          && rect.x + rect.w > other.x
          && rect.y < other.y + other.h
          && rect.y + rect.h > other.y
        ));
        if (blockedBy) {
          ctx.restore();
          return null;
        }
      }
      labelRects.push(rect);

      roundedRect(ctx, boxX, boxY, boxW, boxH, 8);
      ctx.fillStyle = active ? palette.labelBg : palette.labelBgMuted;
      ctx.fill();
      ctx.strokeStyle = rgba(color, active ? 0.75 : (online ? 0.3 : 0.16));
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(boxX + 9, boxY + (compact ? 10.5 : 12), 2.6, 0, TAU);
      ctx.fillStyle = device.blocked ? BLOCK_COLOR : rgba(color, online ? 1 : 0.55);
      ctx.fill();

      ctx.font = `600 11.5px ${FONT}`;
      ctx.fillStyle = online ? palette.labelText : palette.labelMuted;
      ctx.fillText(name, boxX + 16, boxY + (compact ? 10.5 : 12));

      if (sub) {
        ctx.font = `10px ${MONO}`;
        ctx.fillStyle = palette.labelMuted;
        ctx.fillText(sub, boxX + 9, boxY + 25);
      }
      ctx.restore();
    }

    function drawNode(node, point) {
      const device = node.device;
      const style = styleFor(device, themeName);
      const s = node.size * point.scale;
      const online = device.online !== false;
      const selected = node.key === selectedKey;
      const hovered = hoverHit && hoverHit.type === "node" && hoverHit.key === node.key;
      const emphasized = isFocused(device) || selected || hovered;
      const color = emphasized ? style.color : palette.dim;

      ctx.save();
      const dimAlpha = node.isRouter ? 0.5 : 0.22;
      ctx.globalAlpha = (online ? 1 : 0.45) * (emphasized ? 1 : dimAlpha);

      if (emphasized && (selected || hovered || device.is_self || node.isRouter)) {
        const halo = ctx.createRadialGradient(
          point.x, point.y, s * 0.15, point.x, point.y, s * 2.7,
        );
        halo.addColorStop(0, rgba(color, hovered ? 0.3 : 0.16));
        halo.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(point.x, point.y, s * 2.7, 0, TAU);
        ctx.fill();
      }

      if (selected) {
        ctx.strokeStyle = rgba(color, 0.9);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = REDUCED_MOTION ? 0 : -elapsed * 22;
        ctx.beginPath();
        ctx.arc(point.x, point.y, s * 1.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (hovered) {
        ctx.strokeStyle = rgba(color, 0.55);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, s * 1.38, 0, TAU);
        ctx.stroke();
      }

      ctx.translate(point.x, point.y);
      drawDeviceShape(ctx, device, s, color);
      if (device.blocked) drawBlockedBadge(ctx, s);
      ctx.restore();

      // Tree rows sit close together, so their labels are name-only unless
      // the device is active; the detail panel still shows the address.
      const compact = layout === "tree"
        ? !node.isRouter && !selected && !hovered
        : (!online && !selected && !hovered && !node.isRouter);
      if (emphasized) {
        labelQueue.push({
          node,
          point,
          s,
          color,
          online,
          active: selected || hovered,
          compact,
        });
      }

      nodeHits.push({
        type: "node",
        key: node.key,
        x: point.x,
        y: point.y,
        // Tight enough that links can be clicked in the gaps around figures.
        r: node.isRouter ? Math.max(22, s * 0.72) : Math.max(16, s * 0.8),
        node,
      });
    }

    function draw() {
      camera = computeCamera();
      nodeHits.length = 0;
      linkHits.length = 0;
      labelQueue.length = 0;
      labelRects.length = 0;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (layout === "tree") {
        drawTreeBackdrop();
      } else {
        drawFloor();
      }

      const drawables = [];
      if (routerNode) {
        const point = project(routerNode.animated);
        if (point) drawables.push({ node: routerNode, point });
        if (layout !== "tree") drawShadow(routerNode);
      }
      for (const node of nodes) {
        const point = project(node.animated);
        if (point) drawables.push({ node, point });
        if (layout !== "tree") drawShadow(node);
      }

      drawLinks();

      drawables.sort((a, b) => b.point.depth - a.point.depth);
      for (const item of drawables) drawNode(item.node, item.point);

      const priority = (item) => {
        if (item.active) return 0;
        if (item.node.isRouter || item.node.device.is_self) return 1;
        return item.online ? 2 : 3;
      };
      labelQueue.sort((a, b) => priority(a) - priority(b) || a.point.depth - b.point.depth);
      for (const item of labelQueue) {
        drawLabel(
          item.node, item.point, item.s, item.color,
          item.online, item.active, item.compact,
        );
      }

      drawLinkIndicators();
    }

    // -- input -----------------------------------------------------------
    function distanceToPolyline(x, y, points) {
      let best = Infinity;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        let t = lengthSq ? ((x - a.x) * dx + (y - a.y) * dy) / lengthSq : 0;
        t = clamp(t, 0, 1);
        const distance = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
        if (distance < best) best = distance;
      }
      return best;
    }

    function pick(x, y) {
      // A disconnected link's plug is a deliberate target: let it win over a
      // node that happens to sit close to it.
      let plug = null;
      let plugDistance = Infinity;
      for (const hit of linkHits) {
        if (!hit.blocked) continue;
        const distance = Math.hypot(x - hit.mid.x, y - hit.mid.y);
        if (distance <= 12 && distance < plugDistance) {
          plugDistance = distance;
          plug = { type: "link", key: hit.key, node: hit.node, hit };
        }
      }
      if (plug) return plug;

      // Otherwise nodes win over lines that pass behind them.
      let best = null;
      let bestDistance = Infinity;
      for (const hit of nodeHits) {
        const distance = Math.hypot(x - hit.x, y - hit.y);
        if (distance <= hit.r && distance < bestDistance) {
          bestDistance = distance;
          best = { type: "node", key: hit.key, node: hit.node, hit };
        }
      }
      if (best) return best;

      let link = null;
      let linkDistance = Infinity;
      for (const hit of linkHits) {
        const distance = distanceToPolyline(x, y, hit.points);
        if (distance <= 10 && distance < linkDistance) {
          linkDistance = distance;
          link = { type: "link", key: hit.key, node: hit.node, hit };
        }
      }
      return link;
    }

    function setHover(hit) {
      const same = (hoverHit && hit && hoverHit.type === hit.type && hoverHit.key === hit.key)
        || (!hoverHit && !hit);
      hoverHit = hit;
      if (same) return;
      canvas.style.cursor = hit ? "pointer" : "grab";
      if (!hit) {
        onHover(null);
        return;
      }
      const device = hit.node.device;
      if (hit.type === "link") {
        const label = device.label || device.name || device.ip || "device";
        onHover({
          x: hit.hit.mid.x,
          y: hit.hit.mid.y,
          title: device.blocked ? "Reconnect internet" : "Disconnect internet",
          subtitle: canControl
            ? label
            : "Connect the router to control access",
          tone: device.blocked ? "ok" : "accent",
        });
      } else {
        onHover({
          x: hit.hit.x,
          y: hit.hit.y,
          title: device.label || device.name || device.vendor || device.ip || "Device",
          subtitle: device.is_gateway
            ? "Router · click for details"
            : `${styleFor(device, themeName).name}${device.ip ? ` · ${device.ip}` : ""} · click for details`,
          tone: "accent",
        });
      }
    }

    function onPointerDown(event) {
      canvas.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* synthetic pointers (tests) do not own a capture target */
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 1) {
        orbitInertia.yaw = 0;
        orbitInertia.pitch = 0;
        lastDragSample = { x: event.clientX, y: event.clientY, t: performance.now() };
        drag = {
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          button: event.button,
          pan: event.button === 2 || event.shiftKey,
          moved: false,
        };
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
        drag = null;
        lastDragSample = null;
      }
    }

    function onPointerMove(event) {
      const coords = { x: event.clientX, y: event.clientY };
      const previous = pointers.get(event.pointerId);
      if (previous) pointers.set(event.pointerId, coords);

      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const ratio = pinch.distance / distance;
        cam.dist = clamp(cam.dist * ratio, MIN_DIST, MAX_DIST);
        cam.goalDist = cam.dist;
        userAdjusted = true;
        pinch.distance = distance;
        return;
      }

      if (!drag) {
        const rect = canvas.getBoundingClientRect();
        setHover(pick(event.clientX - rect.left, event.clientY - rect.top));
        return;
      }

      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        drag.moved = true;
        canvas.style.cursor = "grabbing";
      }
      if (!drag.moved) return;

      setHover(null);
      if (drag.pan) {
        userAdjusted = true;
        const panScale = cam.dist * 0.0018;
        cam.target.x -= (camera.right.x * dx - camera.up.x * dy) * panScale;
        cam.target.y -= (camera.right.y * dx - camera.up.y * dy) * panScale;
        cam.target.z -= (camera.right.z * dx - camera.up.z * dy) * panScale;
        cam.goalTarget = vec(cam.target.x, cam.target.y, cam.target.z);
        lastDragSample = null;
      } else {
        const now = performance.now();
        if (lastDragSample) {
          const sampleDt = Math.max(0.008, (now - lastDragSample.t) / 1000);
          orbitInertia.yaw = clamp((-dx * 0.0065) / sampleDt, -8, 8);
          orbitInertia.pitch = clamp((dy * 0.0055) / sampleDt, -6, 6);
        }
        lastDragSample = { x: event.clientX, y: event.clientY, t: now };
        cam.yaw -= dx * 0.0065;
        cam.pitch = clamp(cam.pitch + dy * 0.0055, 0.08, 1.24);
      }
    }

    function onPointerUp(event) {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) {
        canvas.style.cursor = "grab";
        return;
      }
      const wasClick = !drag.moved;
      const wasPan = drag.pan;
      drag = null;
      lastDragSample = null;
      canvas.style.cursor = "grab";
      if (!wasClick) {
        if (wasPan || REDUCED_MOTION || autoRotate) {
          orbitInertia.yaw = 0;
          orbitInertia.pitch = 0;
        } else {
          orbitInertia.yaw *= 0.18;
          orbitInertia.pitch *= 0.18;
        }
        return;
      }
      orbitInertia.yaw = 0;
      orbitInertia.pitch = 0;

      const rect = canvas.getBoundingClientRect();
      const hit = pick(event.clientX - rect.left, event.clientY - rect.top);
      if (!hit) {
        setHover(null);
        return;
      }
      if (hit.type === "link") {
        onLinkAction(hit.node.device, hit.key);
      } else {
        selectedKey = hit.key;
        onSelect(hit.node.device, hit.key);
      }
    }

    function onPointerLeave() {
      if (!drag && pointers.size === 0) {
        setHover(null);
        canvas.style.cursor = "grab";
      }
    }

    function onWheel(event) {
      event.preventDefault();
      userAdjusted = true;
      cam.goalDist = clamp(
        cam.goalDist * Math.exp(event.deltaY * 0.0012),
        MIN_DIST,
        MAX_DIST,
      );
    }

    function onKeyDown(event) {
      const step = 0.08;
      switch (event.key) {
        case "ArrowLeft": cam.yaw += step; break;
        case "ArrowRight": cam.yaw -= step; break;
        case "ArrowUp": cam.pitch = clamp(cam.pitch + step * 0.7, 0.08, 1.24); break;
        case "ArrowDown": cam.pitch = clamp(cam.pitch - step * 0.7, 0.08, 1.24); break;
        case "+":
        case "=": cam.goalDist = clamp(cam.goalDist * 0.9, MIN_DIST, MAX_DIST); break;
        case "-":
        case "_": cam.goalDist = clamp(cam.goalDist * 1.1, MIN_DIST, MAX_DIST); break;
        case "0":
        case "r":
        case "R": reset(); break;
        default: return;
      }
      event.preventDefault();
    }

    // -- loop -------------------------------------------------------------
    function frame(now) {
      if (!running) return;
      const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
      lastTime = now;
      elapsed += dt;

      if (autoRotate && !REDUCED_MOTION && layout === "orbit") {
        cam.yaw += dt * 0.16;
      } else if (!REDUCED_MOTION) {
        if (Math.abs(orbitInertia.yaw) > 0.002) {
          cam.yaw += orbitInertia.yaw * dt;
          orbitInertia.yaw *= Math.exp(-dt * 4.5);
        } else {
          orbitInertia.yaw = 0;
        }
        if (Math.abs(orbitInertia.pitch) > 0.002) {
          const nextPitch = clamp(cam.pitch + orbitInertia.pitch * dt, 0.08, 1.24);
          if (nextPitch <= 0.081 || nextPitch >= 1.239) orbitInertia.pitch = 0;
          cam.pitch = nextPitch;
          orbitInertia.pitch *= Math.exp(-dt * 4.5);
        } else {
          orbitInertia.pitch = 0;
        }
      }

      if (needsFit) {
        needsFit = false;
        if (!userAdjusted) applyFit();
      }

      const cameraK = 1 - Math.exp(-dt * 6.5);
      cam.dist = lerp(cam.dist, cam.goalDist, cameraK);
      cam.target.x = lerp(cam.target.x, cam.goalTarget.x, cameraK);
      cam.target.y = lerp(cam.target.y, cam.goalTarget.y, cameraK);
      cam.target.z = lerp(cam.target.z, cam.goalTarget.z, cameraK);

      animatePositions(dt);
      draw();
      rafId = requestAnimationFrame(frame);
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (!userAdjusted) needsFit = true;
      if (!running) draw();
    }

    function setActive(active) {
      if (active === running) return;
      running = active;
      if (active) {
        resize();
        lastTime = 0;
        rafId = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function setSelected(key) {
      selectedKey = key || "";
    }

    function focus(key) {
      const node = key === (routerNode && routerNode.key)
        ? routerNode
        : nodes.find((item) => item.key === key);
      if (!node) return;
      selectedKey = key;
      userAdjusted = true;
      if (layout === "tree") {
        cam.goalTarget = vec(node.pos.x, node.pos.y, 0);
        cam.goalDist = node.isRouter ? 22 : 16;
      } else {
        cam.goalTarget = vec(node.pos.x * 0.82, node.pos.y, node.pos.z * 0.82);
        cam.goalDist = node.isRouter ? 20 : 15;
      }
      setHover(null);
    }

    function reset() {
      const angles = layout === "tree" ? TREE_HOME : ORBIT_HOME;
      cam.yaw = angles.yaw;
      cam.pitch = angles.pitch;
      userAdjusted = false;
      applyFit();
      cam.target = vec(cam.goalTarget.x, cam.goalTarget.y, cam.goalTarget.z);
    }

    function fit() {
      userAdjusted = false;
      if (width && height) applyFit();
    }

    function zoomBy(factor) {
      userAdjusted = true;
      cam.goalDist = clamp(cam.goalDist * factor, MIN_DIST, MAX_DIST);
    }

    function setAutoRotate(value) {
      // A flat tree spinning around its trunk reads as noise, not motion.
      autoRotate = layout === "tree" ? false : !!value;
      if (autoRotate) {
        orbitInertia.yaw = 0;
        orbitInertia.pitch = 0;
      }
    }

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        if (running) resize();
      });
      observer.observe(canvas);
    }

    return {
      sync,
      setActive,
      resize,
      setSelected,
      focus,
      reset,
      fit,
      zoomBy,
      setAutoRotate,
      setLayout,
      getLayout: () => layout,
      getAutoRotate: () => autoRotate,
      types: TYPES,
      redraw: () => { if (!running) draw(); },
    };
  }

  window.NetDash3D = { create, TYPES, typeColor };
})();
