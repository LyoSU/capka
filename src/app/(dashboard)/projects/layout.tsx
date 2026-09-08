import { getTranslations } from "next-intl/server";

import { TITLE_TEMPLATE } from "@/lib/metadata";

// A layout that exists only to name the browser tab: the list page below is a
// client component, and a client module never runs during the server-side
// metadata pass — so its own `metadata` export would be silently dropped.
// Renders `children` bare, adding no element to the tree.
//
// `default` + `template` rather than a plain string: a string title here would
// end the root's template chain, and the project hub one segment down would
// render a bare project name with no brand suffix.
export async function generateMetadata() {
  const t = await getTranslations("projects");
  return { title: { default: t("title"), template: TITLE_TEMPLATE } };
}

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
