import { describe, it, expect } from "vitest";
import {
  decodeTelegramClaims,
  emailSignupAllowed,
  isReservedTelegramEmail,
  parseRegistrationMode,
  resolveRegistration,
  syntheticTelegramEmail,
  telegramDisplayName,
} from "@/lib/auth/telegram-oidc";

/** Build a fake JWT with the given payload (header + payload + empty sig). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("decodeTelegramClaims", () => {
  it("pulls the numeric id, name, username and picture from the id_token", () => {
    const token = jwt({
      sub: "1234123412341234123",
      id: 987654321,
      name: "John Doe",
      preferred_username: "johndoe",
      picture: "https://cdn.telesco.pe/file",
    });
    expect(decodeTelegramClaims(token)).toEqual({
      telegramUserId: 987654321,
      name: "John Doe",
      username: "johndoe",
      picture: "https://cdn.telesco.pe/file",
    });
  });

  it("prefers the numeric `id` claim over `sub` (the bot keys on the numeric id)", () => {
    const claims = decodeTelegramClaims(jwt({ sub: "999", id: 42 }));
    expect(claims?.telegramUserId).toBe(42);
  });

  it("coerces a stringified id and leaves missing optional claims null", () => {
    const claims = decodeTelegramClaims(jwt({ id: "555" }));
    expect(claims).toEqual({ telegramUserId: 555, name: null, username: null, picture: null });
  });

  it("returns null for malformed, empty, or id-less tokens", () => {
    expect(decodeTelegramClaims(null)).toBeNull();
    expect(decodeTelegramClaims("not-a-jwt")).toBeNull();
    expect(decodeTelegramClaims(jwt({ name: "no id here" }))).toBeNull();
    expect(decodeTelegramClaims(jwt({ id: 0 }))).toBeNull();
  });
});

describe("parseRegistrationMode", () => {
  it("passes through known modes", () => {
    expect(parseRegistrationMode("open")).toBe("open");
    expect(parseRegistrationMode("approval")).toBe("approval");
    expect(parseRegistrationMode("closed")).toBe("closed");
  });
  it("fails safe to closed on unknown/empty input", () => {
    expect(parseRegistrationMode(null)).toBe("closed");
    expect(parseRegistrationMode("")).toBe("closed");
    expect(parseRegistrationMode("nonsense")).toBe("closed");
  });
});

describe("resolveRegistration", () => {
  it("before setup completes, creates a plain active user (never admin) regardless of mode", () => {
    // Admin is granted only by the SETUP_TOKEN-gated /api/setup flow — being
    // first to register must NOT confer admin (account-takeover vector).
    for (const mode of ["open", "approval", "closed"] as const) {
      expect(resolveRegistration({ mode, setupDone: false })).toEqual({
        allow: true,
        role: "user",
        status: "active",
      });
    }
  });

  it("open mode admits new users immediately as active", () => {
    expect(resolveRegistration({ mode: "open", setupDone: true })).toEqual({
      allow: true,
      role: "user",
      status: "active",
    });
  });

  it("approval mode parks new users as pending", () => {
    expect(resolveRegistration({ mode: "approval", setupDone: true })).toEqual({
      allow: true,
      role: "user",
      status: "pending",
    });
  });

  it("closed mode rejects new identities", () => {
    expect(resolveRegistration({ mode: "closed", setupDone: true }).allow).toBe(false);
  });
});

describe("emailSignupAllowed", () => {
  it("always allows email sign-up before setup completes (bootstrap the first admin)", () => {
    // Even with email disabled and a closed mode, a fresh instance must let the
    // first admin register via email — otherwise setup can never finish.
    for (const mode of ["open", "approval", "closed"] as const) {
      expect(emailSignupAllowed({ mode, emailEnabled: false, setupDone: false })).toBe(true);
    }
  });

  it("blocks email sign-up once set up when the email toggle is off, even in open mode", () => {
    expect(emailSignupAllowed({ mode: "open", emailEnabled: false, setupDone: true })).toBe(false);
    expect(emailSignupAllowed({ mode: "approval", emailEnabled: false, setupDone: true })).toBe(false);
  });

  it("blocks email sign-up in closed mode even when the email toggle is on", () => {
    expect(emailSignupAllowed({ mode: "closed", emailEnabled: true, setupDone: true })).toBe(false);
  });

  it("allows email sign-up when set up, toggle on, and mode is not closed", () => {
    expect(emailSignupAllowed({ mode: "open", emailEnabled: true, setupDone: true })).toBe(true);
    expect(emailSignupAllowed({ mode: "approval", emailEnabled: true, setupDone: true })).toBe(true);
  });
});

describe("synthetic identity helpers", () => {
  it("builds a stable, internal-looking email from the numeric id", () => {
    expect(syntheticTelegramEmail(42)).toBe("tg42@telegram.local");
  });

  it("falls back through name → @username → numeric id for the display name", () => {
    expect(telegramDisplayName({ telegramUserId: 1, name: "Jane", username: "j", picture: null })).toBe("Jane");
    expect(telegramDisplayName({ telegramUserId: 1, name: null, username: "j", picture: null })).toBe("@j");
    expect(telegramDisplayName({ telegramUserId: 7, name: null, username: null, picture: null })).toBe("Telegram 7");
  });

  it("recognizes the reserved synthetic domain (case-insensitive) to keep it unregistrable", () => {
    expect(isReservedTelegramEmail(syntheticTelegramEmail(42))).toBe(true);
    expect(isReservedTelegramEmail("tg42@telegram.local")).toBe(true);
    expect(isReservedTelegramEmail("  TG42@Telegram.Local  ")).toBe(true);
    expect(isReservedTelegramEmail("real@example.com")).toBe(false);
    expect(isReservedTelegramEmail("telegram.local@example.com")).toBe(false);
  });
});
