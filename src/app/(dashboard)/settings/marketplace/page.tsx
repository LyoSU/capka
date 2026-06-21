import { redirect } from "next/navigation";

// Marketplace merged into the unified Skills & plugins surface. Keep this route
// as a redirect so old links/bookmarks land on the right tab.
export default function MarketplaceRedirect() {
  redirect("/settings/skills?tab=marketplace");
}
