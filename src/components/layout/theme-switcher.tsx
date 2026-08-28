"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "@/components/providers";
import { Monitor, Sun, Moon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Hint } from "@/components/ui/tooltip";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations("theme");

  return (
    <ToggleGroup
      value={theme ? [theme] : ["system"]}
      onValueChange={(values) => {
        if (values.length > 0) setTheme(values[0] as "light" | "dark" | "system");
      }}
      variant="outline"
      size="sm"
    >
      {/* `Hint` renders each item in place (no wrapper node), so the group's
          first/last rounding and roving focus still see three direct children. */}
      <Hint label={t("system")}>
        <ToggleGroupItem value="system" className="h-7 w-7">
          <Monitor className="h-4 w-4" />
        </ToggleGroupItem>
      </Hint>
      <Hint label={t("light")}>
        <ToggleGroupItem value="light" className="h-7 w-7">
          <Sun className="h-4 w-4" />
        </ToggleGroupItem>
      </Hint>
      <Hint label={t("dark")}>
        <ToggleGroupItem value="dark" className="h-7 w-7">
          <Moon className="h-4 w-4" />
        </ToggleGroupItem>
      </Hint>
    </ToggleGroup>
  );
}
