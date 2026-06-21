import { describe, expect, test } from "vitest";
import { fileStatusFromHttp } from "../file-status";

describe("fileStatusFromHttp", () => {
  test("2xx is a present, readable file", () => {
    expect(fileStatusFromHttp(200)).toBe("ok");
    expect(fileStatusFromHttp(206)).toBe("ok"); // ranged read
  });

  test("404 means the file isn't there — a path named but never created", () => {
    expect(fileStatusFromHttp(404)).toBe("gone");
  });

  test("5xx is a transient controller blip, retryable", () => {
    expect(fileStatusFromHttp(500)).toBe("temporary");
    expect(fileStatusFromHttp(502)).toBe("temporary");
  });

  test("other client errors are a hard open error", () => {
    expect(fileStatusFromHttp(400)).toBe("error");
    expect(fileStatusFromHttp(403)).toBe("error");
  });
});
