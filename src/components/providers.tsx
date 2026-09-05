"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { TooltipProvider } from "@/components/ui/tooltip";

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
}>({ theme: "system", setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemTheme() {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/** A theme flip swaps every colour token at once. Each surface carries a
 *  transition on its colours for hover and press, so without this the whole page
 *  shimmers through hundreds of mismatched fades on different clocks for a few
 *  hundred milliseconds. Freeze transitions for the frames the flip takes (the
 *  rule lives in globals.css) so it lands as one clean repaint. Two frames, not
 *  one: the class must outlive the style recalculation the toggle triggers. */
function withFrozenTransitions(flip: () => void) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  flip();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Read the stored preference in the lazy initializer instead of calling
  // setState inside an effect (which would render twice and trip react-hooks).
  // The pre-hydration theme script (inlined in the root layout's <head>) already
  // set the <html> class, so this only seeds the context value.
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof window === "undefined" ? "system" : ((localStorage.getItem("theme") as Theme | null) ?? "system"),
  );

  // Track the on-screen keyboard so bottom-pinned UI can lift above it (iOS).
  useKeyboardInset();

  // The initial <html> class is set pre-hydration by the inline theme script, so
  // we only need to track later system-theme changes while on "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if ((localStorage.getItem("theme") || "system") === "system") {
        withFrozenTransitions(() => applyTheme("system"));
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  function setTheme(t: Theme) {
    setThemeState(t);
    localStorage.setItem("theme", t);
    withFrozenTransitions(() => applyTheme(t));
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {/* One provider for every <Hint>: a shared delay, and no delay at all when
          the pointer moves straight from one hinted control to its neighbour. */}
      <TooltipProvider delay={500} closeDelay={0}>
        {children}
      </TooltipProvider>
    </ThemeContext.Provider>
  );
}
