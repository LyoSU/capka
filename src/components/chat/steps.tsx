import type { ComponentType } from "react";
import {
  FilePlus, FilePen, FileText, Folder, Search, Terminal, Code, Globe, Wrench,
  Sparkles, Plug, SlidersHorizontal,
} from "lucide-react";
import {
  describeStep as describeStepCore,
  type StepIconKey,
  type StepInfo,
  type StepBrand,
  type StepCategory,
  type StepTranslator,
} from "@/lib/chat/steps";

export type { StepBrand, StepCategory, StepTranslator };
export type StepIcon = ComponentType<{ className?: string }>;

/** The web descriptor: the framework-free step info plus its concrete icon. */
export interface StepDescriptor extends StepInfo {
  Icon: StepIcon;
}

const ICONS: Record<StepIconKey, StepIcon> = {
  "file-plus": FilePlus,
  "file-pen": FilePen,
  "file-text": FileText,
  folder: Folder,
  search: Search,
  terminal: Terminal,
  code: Code,
  globe: Globe,
  wrench: Wrench,
  sparkles: Sparkles,
  plug: Plug,
  sliders: SlidersHorizontal,
};

/**
 * Describe a tool call for the UI. The label logic lives in `@/lib/chat/steps`
 * (shared with the server); here we just attach the lucide icon for its key, so
 * the chat transcript and the progress panel render it consistently.
 */
export function describeStep(t: StepTranslator, toolName: string, input?: unknown): StepDescriptor {
  const info = describeStepCore(t, toolName, input);
  return { ...info, Icon: ICONS[info.iconKey] };
}
