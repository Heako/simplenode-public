/**
 * Light or dark interface (Settings → Appearance). The colors are CSS
 * variables in globals.css; the light theme sets `data-theme="light"` on
 * <html>. "system" follows macOS, live. Kept on this computer only.
 */
import { create } from "zustand";

export type Appearance = "dark" | "light" | "system";

const KEY = "simplenode-appearance";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function stored(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

function apply(appearance: Appearance) {
  const light = appearance === "light" || (appearance === "system" && !darkQuery().matches);
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
}

export const useAppearance = create<{ appearance: Appearance; set: (a: Appearance) => void }>((set) => ({
  appearance: typeof window === "undefined" ? "dark" : stored(),
  set: (appearance) => {
    try {
      localStorage.setItem(KEY, appearance);
    } catch {
      // Not saved: still applied for this session.
    }
    apply(appearance);
    set({ appearance });
  },
}));

/** Applies the saved appearance, and follows macOS while it is "system". Call once at startup. */
export function initAppearance() {
  apply(useAppearance.getState().appearance);
  darkQuery().addEventListener("change", () => {
    if (useAppearance.getState().appearance === "system") apply("system");
  });
}
