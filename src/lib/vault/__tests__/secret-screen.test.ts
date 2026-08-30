import { describe, it, expect } from "vitest";
import { looksLikeSecret } from "@/lib/vault/claims";

/**
 * The pattern list on its own. What the screen GUARANTEES — that a secret-shaped
 * statement never becomes an active claim — is proved at the ledger, in
 * `candidates.integration.test.ts`; this file exists because that guarantee runs
 * only under `RUN_INTEGRATION=1`, while a re-tightened or re-widened regex is
 * exactly the kind of change someone makes without a database to hand.
 *
 * Every negative control below is an ordinary fact an office user states out loud.
 * A false positive is not free: a screened item goes `sensitive` → pending, so an
 * ordinary fact ends up on the memory page's review queue, blurred behind a reveal
 * control, waiting for a decision it should never have needed.
 */
describe("looksLikeSecret", () => {
  it.each([
    ["a Postgres connection string with an inline password", "our db is postgresql://svcuser:Sup3rSecretPW9!@db.internal:5432/prod"],
    ["an sk- prefixed API token", "here is my API key sk-ABC123XYZ7890DEF456GHI"],
    // The catch-all deliberately excludes `-` from its class, so this shape is caught
    // ONLY by the widened sk- pattern — this row is what fails if it is narrowed back.
    ["an internally hyphenated OpenAI project key", "sk-proj-AbCdEf0123456789ghijkl"],
    ["a PEM private-key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIExampleNotARealKey==\n-----END RSA PRIVATE KEY-----"],
    ["a GitHub token", "token ghp_ABCdef1234567890abcd"],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a named-secret assignment", 'the config line is password: "hunter22"'],
  ])("screens %s", (_name, statement) => {
    expect(looksLikeSecret(statement)).toBe(true);
  });

  it.each([
    ["an ordinary fact", "pays suppliers in EUR"],
    ["a URL with a long hyphenated slug", "The user prefers the article at https://example.com/how-to-configure-the-thing-properly"],
    ["a preview-deploy hostname", "Staging lives at deploy-preview-1234-my-app-name.netlify.app"],
    ["a UUID", "Project id is 3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
  ])("leaves %s alone", (_name, statement) => {
    expect(looksLikeSecret(statement)).toBe(false);
  });
});
