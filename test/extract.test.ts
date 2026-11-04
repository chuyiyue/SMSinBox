import { describe, expect, it } from "vitest";
import { extractCode } from "../src/extract";

describe("extractCode", () => {
  it("reads Chinese codes next to common labels", () => {
    expect(extractCode("【银行】验证码：123456，5分钟内有效")).toBe("123456");
    expect(extractCode("验证码123456")).toBe("123456");
    expect(extractCode("校验码 8899")).toBe("8899");
    expect(extractCode("动态密码：12345678")).toBe("12345678");
    expect(extractCode("确认码是 4521")).toBe("4521");
    expect(extractCode("安全码：102938")).toBe("102938");
    expect(extractCode("您的短信验证码为 668821，请勿泄露")).toBe("668821");
    expect(extractCode("验证码【384920】")).toBe("384920");
    expect(extractCode("验证码：１２３４５６")).toBe("123456");
  });

  it("reads English verification messages", () => {
    expect(extractCode("Your verification code is 582910")).toBe("582910");
    expect(extractCode("OTP: 019283")).toBe("019283");
    expect(extractCode("Your code is 4421")).toBe("4421");
    expect(extractCode("123456 is your verification code")).toBe("123456");
    expect(extractCode("G-123456 is your Google verification code")).toBe("123456");
    expect(extractCode("Use security code 778899 to sign in")).toBe("778899");
    expect(extractCode("one-time password 445566")).toBe("445566");
  });

  it("prefers the code closest to the keyword", () => {
    expect(extractCode("验证码111111已作废，请使用验证码222222")).toBe("222222");
    expect(extractCode("订单 12345678，验证码 654321")).toBe("654321");
    expect(extractCode("有效期至2026年，验证码 654321")).toBe("654321");
  });

  it("reads codes printed in separated groups, joined", () => {
    expect(
      extractCode("<#> 您的 WhatsApp 验证码：613-408 请不要与他人共享这个密码 4sgLq1p5sV6"),
    ).toBe("613408");
    expect(extractCode("Your verification code is 613 408")).toBe("613408");
    expect(extractCode("验证码：1234-5678，5分钟内有效")).toBe("12345678");
    // A hyphenated date next to the real code must not win.
    expect(extractCode("有效期至 2026-10-31，验证码 654321")).toBe("654321");
    expect(extractCode("订单日期 2026-10-31，验证码：123-456")).toBe("123456");
  });

  it("ignores numbers that are not 4 to 8 digits or have no keyword", () => {
    expect(extractCode("请联系 13800138000")).toBeNull();
    expect(extractCode("订单号 202610311234")).toBeNull();
    expect(extractCode("验证码：123")).toBeNull();
    expect(extractCode("验证码：123456789")).toBeNull();
    expect(extractCode("验证码：12345678901")).toBeNull();
    expect(extractCode("encode: 123456")).toBeNull();
    expect(extractCode("barcode is 12345678")).toBeNull();
    expect(extractCode("")).toBeNull();
    expect(extractCode("hello")).toBeNull();
  });
});
