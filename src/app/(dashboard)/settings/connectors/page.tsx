import { redirect } from "next/navigation";

// Connectors merged into the unified Customize surface. Keep this route as a
// redirect so old links/bookmarks (and any saved OAuth flows) land correctly.
export default function ConnectorsRedirect() {
  redirect("/settings/skills?tab=connectors");
}
