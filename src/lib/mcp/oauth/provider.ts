import { nanoid } from "nanoid";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getClientInfo, saveClientInfo, getUserTokens, saveUserTokens, insertState } from "./store";

/** Public base URL of this deployment — same precedence as better-auth (auth.ts):
 *  PUBLIC_URL is the operator override, BETTER_AUTH_URL the legacy fallback. Used
 *  for the OAuth redirect_uri, so it must match the deployment's real origin. */
function appUrl(): string {
  return (process.env.PUBLIC_URL?.trim() || process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

type Mode = "flow" | "runtime" | "callback";

/**
 * OAuthClientProvider backed by our DB. DCR client info is per-server (shared);
 * tokens are per (user, server). Three modes:
 *  - flow:     starting sign-in — persists state+PKCE and captures the redirect URL.
 *  - callback: finishing sign-in — replays the stored PKCE verifier, saves tokens.
 *  - runtime:  agent run — uses stored tokens (auto-refresh); NEVER redirects.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private _state = "";
  private _verifier = "";
  /** Set by redirectToAuthorization in flow mode; read by the start route. */
  capturedAuthUrl?: URL;

  constructor(
    private readonly userId: string,
    private readonly serverId: string,
    private readonly mode: Mode,
    private readonly presetVerifier?: string,
  ) {}

  get redirectUrl(): string {
    return `${appUrl()}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "unClaw",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client + PKCE (DCR default)
    };
  }

  clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return getClientInfo(this.serverId);
  }

  saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return saveClientInfo(this.serverId, info);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return getUserTokens(this.userId, this.serverId);
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return saveUserTokens(this.userId, this.serverId, tokens);
  }

  state(): string {
    // Memoize: this provider instance backs a single auth flow, so the value
    // persisted via insertState must equal the one placed in the authorization
    // URL even if the SDK reads state() more than once.
    if (!this._state) this._state = nanoid(32);
    return this._state;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._verifier = codeVerifier;
  }

  codeVerifier(): string {
    // Callback replays the verifier persisted during the flow leg.
    return this.mode === "callback" ? (this.presetVerifier ?? "") : this._verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.mode === "runtime") {
      // An agent run must never block on a browser redirect — fail so the
      // connector is skipped and the UI prompts the user to sign in.
      throw new Error("OAuth sign-in required");
    }
    // flow: persist the in-flight state + PKCE verifier, capture the URL.
    await insertState(this._state, this.userId, this.serverId, this._verifier);
    this.capturedAuthUrl = authorizationUrl;
  }
}
