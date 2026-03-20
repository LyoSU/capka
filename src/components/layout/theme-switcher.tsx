"use client";

import { useTheme } from "@/components/providers";
import { Monitor, Sun, Moon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      value={theme ? [theme] : ["system"]}
      onValueChange={(values) => {
        if (values.length > 0) setTheme(values[0] as "light" | "dark" | "system");
      }}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="system" aria-label="System theme" className="h-7 w-7">
        <Monitor className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="light" aria-label="Light theme" className="h-7 w-7">
        <Sun className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark theme" className="h-7 w-7">
        <Moon className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
