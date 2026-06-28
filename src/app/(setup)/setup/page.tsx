import { redirect } from "next/navigation";
import { getSetupState } from "@/lib/setup";
import { SetupWizard } from "@/components/setup/setup-wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const { complete, signedIn, step, setupTokenRequired } = await getSetupState();
  if (complete) {
    redirect("/chat");
  }

  return <SetupWizard initialStep={step} signedIn={signedIn} setupTokenRequired={setupTokenRequired} />;
}
