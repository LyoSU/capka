import { Skeleton } from "@/components/ui/skeleton";

/**
 * Instant loading shell for an existing chat. The chat page awaits the session,
 * the chat row, and the default-model lookup on the server, so this fallback
 * shows during navigation. It mirrors the ChatPanel layout (model pill, message
 * stream, composer) so the swap-in feels seamless rather than a layout jump.
 */
export default function ChatLoading() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-3">
        <Skeleton className="h-8 w-40 rounded-full" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-4 lg:max-w-4xl">
          <div className="flex justify-end">
            <Skeleton className="h-10 w-2/3 rounded-2xl" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-1/2 rounded-2xl" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 pt-6">
        <div className="mx-auto max-w-3xl px-4 pb-4 md:px-6 lg:max-w-4xl">
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
