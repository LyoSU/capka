import { redirect } from "next/navigation";

// Integrations was one admin nav entry holding one section — the Telegram bot
// token. It moved to Agent, where the rest of "how people reach the assistant"
// already lives, and the entry left the menu.
export default function IntegrationsRedirect() {
  redirect("/settings/agent");
}
