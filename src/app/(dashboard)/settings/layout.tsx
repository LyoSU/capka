import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { clientMessages, SETTINGS_SCOPE } from "@/i18n/messages";
import { TITLE_TEMPLATE } from "@/lib/metadata";

// `default` names the section's own page (General has no leaf label of its own);
// each real subpage overrides it from its own layout, carrying only the leaf —
// "Memory · Capka" is what tells two settings tabs apart, where
// "Memory · Settings · Capka" spends three more words saying nothing.
//
// The template is restated rather than inherited: a plain-string `title` here
// would end the root's template chain, and every subpage would render a bare
// "Memory" with no brand suffix at all.
export async function generateMetadata() {
  const t = await getTranslations("settings");
  return { title: { default: t("title"), template: TITLE_TEMPLATE } };
}
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
