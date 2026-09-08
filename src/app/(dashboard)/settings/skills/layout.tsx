import { getTranslations } from "next-intl/server";

// Named on the route, not from the shell that renders the nav: Next streams
// metadata, so its `<title>` commits AFTER hydration and overwrites anything a
// client effect wrote on mount — the tab name has to come from the server.
// `children` passes through bare, adding no element to the tree.
export async function generateMetadata() {
  const t = await getTranslations("settings");
  return { title: t("nav.skills") };
}

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
