import { getSetting, setSetting } from "@/lib/settings";

/** The most recent platform-wide (org) setting change, so OTHER admins learn a
 *  colleague changed shared configuration without having to watch the audit log.
 *  Only the latest is kept — this drives a dismissible banner, not a history. */
export interface OrgChangeNotice {
  actorId: string;
  controlId: string;
  /** Raw new value — the banner localizes the title + value in the viewer's locale. */
  value: string;
  at: number;
}

const KEY = "org_change_notice";

export async function noteOrgChange(actorId: string, controlId: string, value: string): Promise<void> {
  await setSetting(KEY, JSON.stringify({ actorId, controlId, value, at: Date.now() } satisfies OrgChangeNotice));
}

export async function latestOrgChange(): Promise<OrgChangeNotice | null> {
  const raw = await getSetting(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrgChangeNotice;
  } catch {
    return null;
  }
}
