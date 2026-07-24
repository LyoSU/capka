// The generic key/value settings allow-list, split out of route.ts so a test can
// assert it against the `useSetting` call sites (a key a page reads but that isn't
// listed here 403s on both read and write — see __tests__/whitelist.test.ts).
//
// NOT here on purpose: `agent_profile`. It's one validated object, so it has its
// own endpoint (settings/agent-profile) rather than being passed through as an
// opaque JSON string with no server-side shape checking.
export const READABLE_KEYS = [
  "platform_name", "telegram_bot_token", "model_min_context", "model_max_price", "max_context_tokens",
  "sandbox_network", "registration_enabled", "block_private_provider_urls", "share_admin_providers",
  "members_can_install_plugins", "update_check_enabled", "agent_autonomy", "host_folder_access",
  "pc_folder_access",
];

// Identical to READABLE_KEYS today; kept as its own list so a future read-only
// setting can be expressed without weakening the write path by accident.
export const WRITABLE_KEYS = [...READABLE_KEYS];

// Never exposed, whatever the lists above say.
export const BLOCKED_KEYS = ["auth_secret", "setup_complete", "admin_email"];
