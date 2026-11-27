(function () {
  var SKIN_HEX = {
    midnight: "#121212",
    atelier: "#f5f1eb",
    foundry: "#100e0b",
    lagoon: "#dfeceb",
    graphite: "#111214",
    linen: "#eceff3",
    dusk: "#121014",
    daylight: "#fcfcfc",
    meadow: "#ffffff",
    pop: "#fdf5ea",
    halloween: "#110d16",
    diwali: "#100d1f",
    aurora: "#0b0c0b",
  };
  var DARK = {
    midnight: 1,
    foundry: 1,
    graphite: 1,
    dusk: 1,
    halloween: 1,
    diwali: 1,
    aurora: 1,
  };
  try {
    window.__ombBootTs =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
  } catch {}

  var choice = null;
  try {
    choice = window.localStorage.getItem("omb-skin");
  } catch {}

  var prefersDark = true;
  try {
    if (typeof window.matchMedia === "function") {
      prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch {}

  var skin =
    choice && choice !== "system" && Object.prototype.hasOwnProperty.call(SKIN_HEX, choice)
      ? choice
      : prefersDark
        ? "midnight"
        : "daylight";
  var bg = SKIN_HEX[skin] || "#121212";
  var isDark = Boolean(DARK[skin]);

  var root = document.documentElement;
  root.dataset.skin = skin;
  root.style.colorScheme = isDark ? "dark" : "light";
  root.style.setProperty("--boot-bg", bg);
  root.style.setProperty("--boot-card", isDark ? "#1a1a1a" : "#f2f2f2");
  root.style.setProperty("--boot-line", isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)");

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", bg);
})();
