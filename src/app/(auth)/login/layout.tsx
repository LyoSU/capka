import { getTranslations } from "next-intl/server";

// A layout that exists only to name the browser tab: the page below is a client
// component, and a client module never runs during the server-side metadata pass
// — so its own `metadata` export would be silently dropped. Renders `children`
// bare, adding no element to the tree.
export async function generateMetadata() {
  const t = await getTranslations("auth.login");
  return { title: t("title") };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
