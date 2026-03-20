import { Separator } from "@/components/ui/separator";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";

export default function GeneralSettingsPage() {
  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">Appearance</h2>
        <p className="text-sm text-muted-foreground">
          Choose how AntiClaw looks on your device.
        </p>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Theme</label>
        <ThemeSwitcher />
      </div>
    </div>
  );
}
