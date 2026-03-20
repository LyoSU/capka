import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/settings";

export default async function Home() {
  const complete = await isSetupComplete();

  if (!complete) {
    redirect("/setup");
  }

  redirect("/chat");
}
