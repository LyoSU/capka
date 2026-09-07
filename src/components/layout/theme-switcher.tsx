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
        <ToggleGroupItem value="system">
          <Monitor />
        </ToggleGroupItem>
      </Hint>
      <Hint label={t("light")}>
        <ToggleGroupItem value="light">
          <Sun />
        </ToggleGroupItem>
      </Hint>
      <Hint label={t("dark")}>
        <ToggleGroupItem value="dark">
          <Moon />
        </ToggleGroupItem>
      </Hint>
    </ToggleGroup>
  );
}
