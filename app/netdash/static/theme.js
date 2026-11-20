/* Apply the saved appearance before the stylesheet paints, avoiding a flash. */
(() => {
  "use strict";
  try {
    const stored = localStorage.getItem("netdash-theme") || "auto";
    const mode = stored === "light" || stored === "dark" ? stored : "auto";
    const systemDark = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true;
    const theme = mode === "auto" ? (systemDark ? "dark" : "light") : mode;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themeMode = mode;
    root.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "auto";
  }
})();
