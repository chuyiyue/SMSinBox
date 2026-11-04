import { describe, expect, it } from "vitest";
import { parseUserAgent } from "../src/user-agent";

describe("parseUserAgent", () => {
  it("parses desktop Chrome on Windows", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    expect(info).toEqual({ browser: "Chrome 131", os: "Windows 10/11", device: "桌面设备" });
  });

  it("prefers Edge over Chrome when both tokens are present", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    );
    expect(info.browser).toBe("Edge 131");
  });

  it("parses Safari on iPhone as a phone", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    );
    expect(info).toEqual({ browser: "Safari 17", os: "iOS 17", device: "手机" });
  });

  it("parses Firefox on an Android tablet", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Android 14; Tablet; rv:133.0) Gecko/133.0 Firefox/133.0",
    );
    expect(info).toEqual({ browser: "Firefox 133", os: "Android 14", device: "平板" });
  });

  it("parses Chrome on macOS", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    expect(info).toEqual({ browser: "Chrome 130", os: "macOS 10.15", device: "桌面设备" });
  });

  it("returns nulls for missing or empty agents", () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, device: null });
    expect(parseUserAgent("")).toEqual({ browser: null, os: null, device: null });
    expect(parseUserAgent(undefined)).toEqual({ browser: null, os: null, device: null });
  });

  it("keeps the device class for an unrecognized agent", () => {
    const info = parseUserAgent("SomeCustomClient/2.0 (Linux; x86_64)");
    expect(info.browser).toBeNull();
    expect(info.os).toBe("Linux");
    expect(info.device).toBe("桌面设备");
  });
});
