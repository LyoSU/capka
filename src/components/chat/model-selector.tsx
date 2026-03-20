"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ModelSelectorProps {
  providers: Record<string, string[]>;
  value: string;
  onChange: (value: string) => void;
}

export function ModelSelector({ providers, value, onChange }: ModelSelectorProps) {
  return (
    <Select value={value} onValueChange={(v) => { if (v) onChange(v); }}>
      <SelectTrigger size="sm" className="h-7 border-none bg-transparent text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(providers)
          .filter(([, models]) => models.length > 0)
          .map(([provider, models]) => (
            <SelectGroup key={provider}>
              <SelectLabel className="capitalize">{provider}</SelectLabel>
              {models.map((model) => (
                <SelectItem key={`${provider}:${model}`} value={`${provider}:${model}`}>
                  {model}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
      </SelectContent>
    </Select>
  );
}
