import { NextIntlClientProvider } from "next-intl";
import { clientMessages, SETTINGS_SCOPE } from "@/i18n/messages";
import { SettingsShell } from "./settings-shell";

// The `settings` namespace is half the catalog, and only these pages read it —
// so it enters here and not in the dashboard layout, which every chat also pays
// for. The shell itself is a client component (it reads the pathname), hence the
// split: a layout that provides messages has to be a server component.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider messages={await clientMessages(SETTINGS_SCOPE)}>
      <SettingsShell>{children}</SettingsShell>
    </NextIntlClientProvider>
  );
}
