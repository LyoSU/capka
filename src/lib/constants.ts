export const MEMORY_TYPES = ["fact", "preference", "context"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
