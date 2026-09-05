import { NextIntlClientProvider } from "next-intl";
import { clientMessages, SETUP_SCOPE } from "@/i18n/messages";

// The first-run shell (brand panel + form) lives in <SetupWizard> so the brand
// panel can reflect live step progress. This layout owns the viewport and the
// one namespace the wizard adds to the signed-out scope.
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider messages={await clientMessages(SETUP_SCOPE)}>
      <div className="min-h-dvh bg-background">{children}</div>
    </NextIntlClientProvider>
  );
}
