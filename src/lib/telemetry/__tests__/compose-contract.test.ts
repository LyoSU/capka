import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveTelemetryConfig } from "../config";

/**
 * The contract between this module and `docker-compose.yml`.
 *
 * `environment:` for the platform service is an explicit whitelist: a variable set
 * on the host (or in a Coolify service) reaches compose but NOT the container
 * unless it is passed through by name. v0.21.0 shipped tracing that could never
 * start in any container deployment for exactly this reason — with no error
 * anywhere, just an empty project in the operator's backend.
 *
 * So these are not edge-case tests. They assert the two statements the compose
 * file now carries: every knob this module reads is passed through, and the
 * `${VAR:-}` pattern it uses does not switch anything on.
 */
const COMPOSE = readFileSync("docker-compose.yml", "utf8");
const CONFIG_SOURCE = readFileSync("src/lib/telemetry/config.ts", "utf8");

/** The platform service's environment block, where the whitelist lives. */
function platformEnvironment(): string {
  const start = COMPOSE.indexOf("\n  platform:");
  expect(start).toBeGreaterThan(-1);
  const rest = COMPOSE.slice(start + 1);
  // Up to the next top-level service key (two-space indent, non-blank).
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("docker-compose passes through every telemetry knob", () => {
  it("forwards each env var this module reads into the platform container", () => {
    // Whatever config.ts reads off `env`, the container must actually receive.
    const read = [...CONFIG_SOURCE.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(5); // guard against the regex silently matching nothing

    const passedThrough = platformEnvironment();
    const missing = [...new Set(read)].filter((name) => !passedThrough.includes(`${name}=`));

    expect(missing, `not passed into the platform container in docker-compose.yml: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the ${VAR:-} pattern must not switch tracing on", () => {
  // compose substitutes an UNSET variable as an empty string, not as absent — a
  // different input than the `{}` the default-off tests use.
  const EMPTY = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
    OTEL_EXPORTER_OTLP_PROTOCOL: "",
    OTEL_SERVICE_NAME: "",
    OTEL_SDK_DISABLED: "",
    OTEL_TRACES_EXPORTER: "",
    CAPKA_TELEMETRY_CONTENT: "",
    CAPKA_TELEMETRY_CONTENT_REMOTE: "",
    CAPKA_TELEMETRY_COST: "",
    CAPKA_TELEMETRY_SPAN_PREFIXES: "",
    CAPKA_TELEMETRY_EXTRA_ATTRIBUTES: "",
  };

  it("stays disabled when every variable is present but empty", () => {
    const c = resolveTelemetryConfig(EMPTY);
    expect(c.enabled).toBe(false);
    expect(c.tracesUrl).toBe("");
  });

  it("does not read an empty exporter name as a non-otlp exporter", () => {
    // `exporter && exporter !== "otlp"` must not treat "" as "some other exporter",
    // which would disable tracing even when an endpoint IS configured.
    const c = resolveTelemetryConfig({
      ...EMPTY,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    expect(c.enabled).toBe(true);
  });

  it("keeps content off, and keeps the defaults, on empty strings", () => {
    const c = resolveTelemetryConfig({ ...EMPTY, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    expect(c.content.enabled).toBe(false);
    expect(c.includeCost).toBe(false);
    expect(c.protocol).toBe("http/protobuf");
    // An empty prefix list must not become "export everything".
    expect(c.spanNamePrefixes).toEqual(["capka.", "ai."]);
    expect(c.extraAllowedAttributes).toEqual([]);
  });
});
