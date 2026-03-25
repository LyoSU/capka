import { getSetting } from "@/lib/settings";

export async function GET() {
  const value = await getSetting("registration_enabled");
  return Response.json({ enabled: value !== "false" });
}
