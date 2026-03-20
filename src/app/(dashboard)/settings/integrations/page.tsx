import { Separator } from "@/components/ui/separator";

export default function IntegrationsPage() {
  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect external services to AntiClaw.
        </p>
      </div>
      <Separator />
      <p className="text-sm text-muted-foreground">
        Telegram integration will be configured here.
      </p>
    </div>
  );
}
