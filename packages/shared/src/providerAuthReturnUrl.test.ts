import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["monarch", "monarch-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "monarch://attacker/welcome",
    "monarch://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});

it("uses hosted auth return origins only when explicitly configured", () => {
  expect(providerAuthReturnUrl("https://app.t3.codes/welcome")).toBeUndefined();
  expect(providerAuthReturnUrl("https://monarch.example/welcome", "https://monarch.example")).toBe(
    "https://monarch.example/welcome",
  );
  expect(
    providerAuthReturnUrl("https://other.example/welcome", "https://monarch.example"),
  ).toBeUndefined();
});
