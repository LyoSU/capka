import { notFound } from "next/navigation";
import { CitationsHarness } from "./harness";

/** Visual rig for the citation chips + sources footer. Same double gate as
 *  dev/chat-scroll: NODE_ENV alone would leave a self-hoster's dev build
 *  serving an unauthenticated page. */
export const dynamic = "force-dynamic";

export default function DevCitationsPage() {
  if (process.env.NODE_ENV === "production" || process.env.CAPKA_SCROLL_HARNESS !== "1") notFound();
  return <CitationsHarness />;
}
