import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/settings";
import { SetupWizard } from "@/components/setup/setup-wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const complete = await isSetupComplete();
  if (complete) {
    redirect("/chat");
  }

  return <SetupWizard />;
}
