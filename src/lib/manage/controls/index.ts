import { createRegistry, type Registry } from "../registry";
import { userControls } from "./user-settings";
import { orgControls } from "./org-settings";
import { mcpCollection } from "./mcp";
import { skillCollection } from "./skills";

/** The full set of chat-manageable controls. Registration order is stable so the
 *  `list`/`capabilities` output — and thus the tools prefix behaviour — is
 *  deterministic. Adding a future capability (MCP, skill, folder access) means
 *  appending its controls here; nothing in the dispatcher or runner changes. */
export function buildRegistry(): Registry {
  return createRegistry([...userControls, ...orgControls], [mcpCollection, skillCollection]);
}
