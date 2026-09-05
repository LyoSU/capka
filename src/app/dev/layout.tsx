import { NextIntlClientProvider } from "next-intl";
import { clientMessages, DEV_SCOPE } from "@/i18n/messages";

// The dev harnesses mount chat components directly (Markdown, CitedSourcesFooter),
// outside the dashboard layout that would otherwise provide their namespace.
export default async function DevLayout({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider messages={await clientMessages(DEV_SCOPE)}>{children}</NextIntlClientProvider>
  );
}
