import { useEffect, useState } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "outfitterTheme";

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    // localStorage unavailable (private browsing, disabled storage) -- fall through to the OS
    // preference via prefers-color-scheme; the app still themes correctly, it just can't persist.
    return null;
  }
}

function writeStored(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // best-effort only
  }
}

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Manual dark/light override on top of prefers-color-scheme, persisted to localStorage. Sets
 * `data-theme` on the root element, which theme.css's `:root[data-theme=...]` rules key off. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? systemTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    writeStored(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={theme === "dark" ? "Dark (C64 phosphor)" : "Light (GEOS paper)"}
    >
      {theme === "dark" ? "◐ DARK" : "◑ LIGHT"}
    </button>
  );
}
