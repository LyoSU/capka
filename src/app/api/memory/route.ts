import { apiHandler, requireActive } from "@/lib/auth";
import { readMemoryPage } from "@/lib/vault/memory-page";

/**
 * The memory page's own endpoint. It replaces `/api/memory-docs`, which served a
 * markdown projection of the same data — a shape that could carry no provenance, no
 * version history, no waiting list and no controls, because a string has nowhere to put
 * them. That is why there is no interim version of this: changing the response shape and
 * the component that renders it is the same change.
 *
 * `requireActive` and self-scoped: there is no user parameter anywhere here, and an
 * admin reading somebody else's memory is not a thing this route can express. Later
 * tasks add PATCH (consent) and DELETE (reset) beside this.
 */
export const GET = apiHandler(async () => {
  const { userId } = await requireActive();
  return Response.json(await readMemoryPage(userId));
});
