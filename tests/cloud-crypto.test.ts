import { describe, expect, it } from "vitest";
import { decryptSession, encryptSession } from "../cloud/crypto.js";

const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("hosted ecobee session encryption", () => {
  it("restores a browser session without retaining its sensitive text in storage", async () => {
    const state = { cookies: [{ name: "ecobee", value: "private-cookie-value" }], origins: [] };
    const encrypted = await encryptSession(secret, state, "tenant-123");
    expect(JSON.stringify(encrypted)).not.toContain("private-cookie-value");
    expect(await decryptSession(secret, encrypted, "tenant-123")).toEqual(state);
  });

  it("rejects sessions moved to another tenant", async () => {
    const encrypted = await encryptSession(secret, { cookies: [] }, "tenant-123");
    await expect(decryptSession(secret, encrypted, "tenant-456")).rejects.toThrow();
  });

  it("rejects a modified session and a different deployment key", async () => {
    const encrypted = await encryptSession(secret, { cookies: [] }, "tenant-123");
    const changed = { ...encrypted, ciphertext: (encrypted.ciphertext[0] === "A" ? "B" : "A") + encrypted.ciphertext.slice(1) };
    await expect(decryptSession(secret, changed, "tenant-123")).rejects.toThrow();
    const otherSecret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(decryptSession(otherSecret, encrypted, "tenant-123")).rejects.toThrow();
  });

  it("uses fresh encryption nonces and rejects malformed keys", async () => {
    const first = await encryptSession(secret, {}, "tenant-123");
    const second = await encryptSession(secret, {}, "tenant-123");
    expect(first.iv).not.toEqual(second.iv);
    await expect(encryptSession("not-a-valid-key", {}, "tenant-123")).rejects.toThrow("32-byte key");
  });
});
