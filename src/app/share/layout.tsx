import { NextIntlClientProvider } from "next-intl";
import { clientMessages, SHARE_SCOPE } from "@/i18n/messages";

// A shared chat renders the real message components, so it needs `chat` — but
// nothing else the dashboard carries, and its readers are signed out.
export default async function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider messages={await clientMessages(SHARE_SCOPE)}>{children}</NextIntlClientProvider>
  );
}
