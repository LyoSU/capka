import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { Header } from "@/components/layout/header";
import { FileBrowser } from "@/components/files/file-browser";

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { projectId } = await searchParams;

  return (
    <>
      <Header title="Files" />
      <FileBrowser projectId={projectId} />
    </>
  );
}
