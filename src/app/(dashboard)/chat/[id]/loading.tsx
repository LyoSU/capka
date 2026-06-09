import { Skeleton } from "@/components/ui/skeleton";

/**
 * Instant loading shell for a chat. The page awaits the session, the chat row,
 * and the default-model lookup on the server, so this fallback shows during
 * navigation. It deliberately renders only the always-present chrome — the model
 * pill on top and the composer at the bottom — and leaves the middle empty.
 * A NEW chat resolves to the centered greeting and an EXISTING one to a message
 * stream; faking message bubbles here would imply history a new chat doesn't
 * have, so the neutral shell fits both without a jarring swap.
 */
export default function ChatLoading() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-3">
        <Skeleton className="h-8 w-40 rounded-full" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>

      <div className="flex-1" />

      <div className="absolute inset-x-0 bottom-0 pt-6">
        <div className="mx-auto max-w-3xl px-4 pb-4 md:px-6 lg:max-w-4xl">
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
