import { createRegistry, type Registry } from "../registry";
import { userControls } from "./user-settings";
import { orgControls } from "./org-settings";
import { mcpCollection } from "./mcp";
import { skillCollection } from "./skills";
import { automationCollection } from "./automations";

/** The full set of chat-manageable controls. Registration order is stable so the
 *  `list`/`capabilities` output — and thus the tools prefix behaviour — is
 *  deterministic. Adding a future capability (MCP, skill, folder access) means
 *  appending its controls here; nothing in the dispatcher or runner changes. */
let cached: Registry | undefined;
export function buildRegistry(): Registry {
  // The registry is stateless (controls delegate to the service layer), so one
  // instance is shared process-wide — callers (the tool, the web confirm
  // endpoint, the Telegram callback) no longer each rebuild it per request/tap.
  return (cached ??= createRegistry([...userControls, ...orgControls], [mcpCollection, skillCollection, automationCollection]));
}
