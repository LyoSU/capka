import { redirect } from "next/navigation";

// Sign-in settings are a tab of People now — one page for who is in and who may
// get in. Kept as a redirect because this path is linked from docs and bookmarks.
export default function AuthenticationRedirect() {
  redirect("/settings/users?tab=signin");
}
