import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatSize } from "@/lib/constants";
import type { AttachedFile } from "./chat-input";

/** Max single file size for upload (100MB) */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Validate + stage files onto the existing list. Centralised so the composer box,
 * the full-window drop zone, and paste all enforce the same size cap and surface
 * the same friendly rejection toast.
 */
export function useFileAttach(
  files: AttachedFile[],
  onFilesChange: (files: AttachedFile[]) => void,
) {
  const t = useTranslations("chat.input");
  return useCallback(
    (newFiles: FileList | File[]) => {
      const valid: AttachedFile[] = [];
      const rejected: string[] = [];
      for (const file of Array.from(newFiles)) {
        if (file.size > MAX_FILE_SIZE) {
          rejected.push(`${file.name} (${formatSize(file.size)})`);
        } else {
          valid.push({ file, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
        }
      }
      if (rejected.length > 0) {
        toast.error(t("tooLarge", { max: formatSize(MAX_FILE_SIZE), files: rejected.join(", ") }));
      }
      if (valid.length > 0) onFilesChange([...files, ...valid]);
    },
    [files, onFilesChange, t],
  );
}
