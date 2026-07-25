import { redirect } from "next/navigation";

// Permissions moved next to the things they govern: a tab of Extensions, beside
// the skills and connectors whose access they allow or deny.
export default function PermissionsRedirect() {
  redirect("/settings/skills?tab=permissions");
}
