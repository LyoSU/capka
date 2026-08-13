import { describe, it, expect } from "vitest";
import { resolveTelemetryConfig, telemetrySettingsFrom, sanitizeRoute } from "../config";

// Mirrors the config-check.test.ts style: one baseline env, each case overrides
// a single var so every assertion is about that var alone.
const BASE = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" };

describe("resolveTelemetryConfig — enablement", () => {
  it("is disabled when no endpoint is configured", () => {
    expect(resolveTelemetryConfig({}).enabled).toBe(false);
  });

  it("appends /v1/traces to a base endpoint", () => {
    const c = resolveTelemetryConfig(BASE);
    expect(c.enabled).toBe(true);
    expect(c.tracesUrl).toBe("https://collector.example.com/v1/traces");
  });

  it("strips a trailing slash before appending the signal path", () => {
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com/" }).tracesUrl)
      .toBe("https://c.example.com/v1/traces");
  });

  it("uses a signal-specific endpoint verbatim and prefers it over the base", () => {
    const c = resolveTelemetryConfig({
      ...BASE,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://lf.example.com/api/public/otel/v1/traces",
    });
    expect(c.tracesUrl).toBe("https://lf.example.com/api/public/otel/v1/traces");
  });

  it("honors OTEL_SDK_DISABLED even with an endpoint set", () => {
    expect(resolveTelemetryConfig({ ...BASE, OTEL_SDK_DISABLED: "true" }).enabled).toBe(false);
  });

  it("honors OTEL_TRACES_EXPORTER=none even with an endpoint set", () => {
    expect(resolveTelemetryConfig({ ...BASE, OTEL_TRACES_EXPORTER: "none" }).enabled).toBe(false);
  });

  it("keeps otlp as an explicitly valid exporter value", () => {
    expect(resolveTelemetryConfig({ ...BASE, OTEL_TRACES_EXPORTER: "otlp" }).enabled).toBe(true);
  });

  it("is disabled when the endpoint is not a valid http(s) URL", () => {
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }).enabled).toBe(false);
  });

  it("prefers signal-specific headers over the generic ones", () => {
    const c = resolveTelemetryConfig({
      ...BASE,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic generic",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Basic signal,x-langfuse-ingestion-version=4",
    });
    expect(c.headers).toEqual({
      "Authorization": "Basic signal",
      "x-langfuse-ingestion-version": "4",
    });
  });
});

describe("resolveTelemetryConfig — content policy (fail-closed)", () => {
  it("records no content by default", () => {
    const c = resolveTelemetryConfig(BASE);
    expect(c.content.enabled).toBe(false);
  });

  it("allows content toward a loopback endpoint with one flag", () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    expect(c.content.enabled).toBe(true);
  });

  it("treats a private-range endpoint as local", () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://10.1.2.3:4318",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    expect(c.content.enabled).toBe(true);
  });

  it("FORCES content off toward a public endpoint without the remote acknowledgement", () => {
    const c = resolveTelemetryConfig({ ...BASE, CAPKA_TELEMETRY_CONTENT: "true" });
    expect(c.content.enabled).toBe(false);
    // The operator asked for something unsafe; the reason must be reportable, not silent.
    expect(c.content.blockedReason).toContain("collector.example.com");
  });

  it("allows content toward a public endpoint once the remote flag is also set", () => {
    const c = resolveTelemetryConfig({
      ...BASE,
      CAPKA_TELEMETRY_CONTENT: "true",
      CAPKA_TELEMETRY_CONTENT_REMOTE: "true",
    });
    expect(c.content.enabled).toBe(true);
    expect(c.content.blockedReason).toBeUndefined();
  });

  it("does not treat a hostname merely containing 'localhost' as local", () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://localhost.evil.example.com",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    expect(c.content.enabled).toBe(false);
  });
});

describe("telemetrySettingsFrom — what the AI SDK is told", () => {
  it("is disabled when telemetry is off", () => {
    const s = telemetrySettingsFrom(resolveTelemetryConfig({}), "capka.turn.llm");
    expect(s.isEnabled).toBe(false);
  });

  it("ALWAYS states recordInputs/recordOutputs, because the SDK defaults them to true", () => {
    const s = telemetrySettingsFrom(resolveTelemetryConfig(BASE), "capka.turn.llm");
    expect(s.isEnabled).toBe(true);
    expect(s.recordInputs).toBe(false);
    expect(s.recordOutputs).toBe(false);
    // Not merely falsy — the keys must be present, since omitting them means "true".
    expect(Object.keys(s)).toContain("recordInputs");
    expect(Object.keys(s)).toContain("recordOutputs");
  });

  it("records content only once the policy allows it", () => {
    const cfg = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    const s = telemetrySettingsFrom(cfg, "capka.turn.llm");
    expect(s.recordInputs).toBe(true);
    expect(s.recordOutputs).toBe(true);
  });

  it("keeps content off when the policy blocked an unsafe request", () => {
    const cfg = resolveTelemetryConfig({ ...BASE, CAPKA_TELEMETRY_CONTENT: "true" });
    const s = telemetrySettingsFrom(cfg, "capka.turn.llm");
    expect(s.recordInputs).toBe(false);
  });

  it("passes the function id and metadata through for grouping", () => {
    const s = telemetrySettingsFrom(resolveTelemetryConfig(BASE), "capka.aux.title", { "capka.task.id": "t1" });
    expect(s.functionId).toBe("capka.aux.title");
    expect(s.metadata).toEqual({ "capka.task.id": "t1" });
  });
});

describe("resolveTelemetryConfig — tunables instead of hardcoding", () => {
  it("defaults to forwarding only agent spans but lets an operator widen it", () => {
    expect(resolveTelemetryConfig(BASE).spanNamePrefixes).toEqual(["capka.", "ai."]);
    expect(
      resolveTelemetryConfig({ ...BASE, CAPKA_TELEMETRY_SPAN_PREFIXES: "capka.,ai.,next." }).spanNamePrefixes,
    ).toEqual(["capka.", "ai.", "next."]);
  });

  it("treats '*' as no name filtering at all", () => {
    expect(resolveTelemetryConfig({ ...BASE, CAPKA_TELEMETRY_SPAN_PREFIXES: "*" }).spanNamePrefixes).toEqual([]);
  });

  it("lets an operator allow extra attribute keys without waiting for a release", () => {
    const c = resolveTelemetryConfig({ ...BASE, CAPKA_TELEMETRY_EXTRA_ATTRIBUTES: "ai.settings.output, vendor.thing." });
    expect(c.extraAllowedAttributes).toEqual(["ai.settings.output", "vendor.thing."]);
  });

  it("defaults to http/protobuf and accepts http/json", () => {
    expect(resolveTelemetryConfig(BASE).protocol).toBe("http/protobuf");
    expect(resolveTelemetryConfig({ ...BASE, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }).protocol).toBe("http/json");
  });

  it("falls back to http/protobuf for an unsupported protocol and says so", () => {
    const c = resolveTelemetryConfig({ ...BASE, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(c.protocol).toBe("http/protobuf");
    expect(c.unsupportedProtocol).toBe("grpc");
  });
});

describe("sanitizeRoute — low-cardinality paths with no identifiers", () => {
  it("strips the query string, which is where the workspace token lives", () => {
    expect(sanitizeRoute("/sessions/chat_abc123?userId=u_1&token=deadbeef")).toBe("/sessions/{id}");
  });

  it("keeps collection and sub-resource names, masking the slots between them", () => {
    expect(sanitizeRoute("/sessions/chat_abc123/exec")).toBe("/sessions/{id}/exec");
    // Positional, not a lookup table: an action in an id slot is masked too. That
    // loses a little detail (`/mounts/validate` → `/mounts/{id}`) and is the
    // deliberate trade — no algorithm can tell an action word from a user's MCP
    // server name, so the rule errs toward hiding.
    expect(sanitizeRoute("/mounts/validate")).toBe("/mounts/{id}");
  });

  it("hides user-supplied MCP server names", () => {
    expect(sanitizeRoute("/sessions/proj_9/mcp/my-private-server/rpc")).toBe("/sessions/{id}/mcp/{id}/rpc");
  });

  it("hides anything unfamiliar rather than guessing it is safe", () => {
    // A future endpoint must not leak just because nobody updated a lookup table.
    expect(sanitizeRoute("/sessions/x1/files/Q3%20salaries.xlsx")).toBe("/sessions/{id}/files/{id}");
  });

  it("is stable for a path with no identifiers", () => {
    expect(sanitizeRoute("/health")).toBe("/health");
  });
});
