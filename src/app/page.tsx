import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/settings";

export default async function Home() {
  const complete = await isSetupComplete();

  if (!complete) {
    redirect("/setup");
  }

  const cookieStore = await cookies();
  cookieStore.set("setup_complete", "1", {
    httpOnly: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect("/chat");
}
