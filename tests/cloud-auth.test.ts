import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedLogin, cookie, cookieValue, githubIdentity, githubUrl, nonce, sign, verify, type Identity } from "../cloud/auth.js";

const secret = "test-cookie-secret-at-least-32-characters";
const githubEnv = { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-client-secret", PUBLIC_ORIGIN: "https://thermostat.example" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signed hosted session", () => {
  it("roundtrips a session and rejects changes to its body or signature", async () => {
    const identity: Identity = { userId: "12345", login: "home-owner", csrf: "private-csrf", exp: Date.now() + 60_000 };
    const signed = await sign(identity, secret);
    expect(await verify<Identity>(signed, secret)).toEqual(identity);
    const [body, signature] = signed.split(".");
    const otherBody = btoa(JSON.stringify({ ...identity, userId: "99999" })).replace(/=/g, "");
    expect(await verify(`${otherBody}.${signature}`, secret)).toBeNull();
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(await verify(`${body}.${changedSignature}`, secret)).toBeNull();
    expect(await verify(signed, `${secret}-other-deployment`)).toBeNull();
  });

  it("expires sessions at the signed deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const signed = await sign({ userId: "12345", exp: Date.now() + 1_000 }, secret);
    expect(await verify(signed, secret)).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await verify(signed, secret)).toBeNull();
  });

  it.each([undefined, "", "bad", "body.signature.extra", "!invalid!.!signature!", "a".repeat(8193)])("rejects malformed cookie %s", async value => {
    expect(await verify(value, secret)).toBeNull();
  });

  it("rejects signed payloads without a future numeric expiration", async () => {
    for (const payload of [{}, { exp: "tomorrow" }, { exp: 0 }, { exp: Date.now() - 1 }]) {
      expect(await verify(await sign(payload, secret), secret)).toBeNull();
    }
    await expect(sign({ exp: Date.now() + 1000 }, "too-short")).rejects.toThrow("Cookie secret");
  });

  it("generates independent URL-safe CSRF and flow nonces", () => {
    const first = nonce();
    const second = nonce();
    expect(first).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("uses host-only secure cookies and reads an exact cookie name", () => {
    const header = cookie("__Host-openecobee", "signed-session", 3600);
    expect(header).toBe("__Host-openecobee=signed-session; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600");
    expect(header).not.toContain("Domain=");
    const request = new Request("https://thermostat.example", { headers: { Cookie: "other=x; __Host-openecobee-login=flow; __Host-openecobee=signed-session" } });
    expect(cookieValue(request, "__Host-openecobee")).toBe("signed-session");
    expect(cookieValue(request, "missing")).toBeUndefined();
  });
});

describe("GitHub identity allowlist", () => {
  it.each([undefined, "", " , ", "somebody-else", "prefix-home-owner"]) ("denies a user when configuration is %s", allowed => {
    expect(allowedLogin("home-owner", allowed)).toBe(false);
  });

  it("matches complete names case-insensitively and permits an explicit wildcard only", () => {
    expect(allowedLogin("Home-Owner", " teammate, HOME-owner ")).toBe(true);
    expect(allowedLogin("any-user", "*")).toBe(true);
    expect(allowedLogin("any-user", "any-*")).toBe(false);
  });
});

describe("GitHub OAuth", () => {
  it("uses an S256 PKCE challenge and the configured callback origin", async () => {
    const verifier = "a-long-random-browser-flow-verifier";
    const url = new URL(await githubUrl("flow-state", verifier, githubEnv));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "test-client", redirect_uri: "https://thermostat.example/callback", state: "flow-state", code_challenge_method: "S256", code_challenge: challenge });
    expect(url.href).not.toContain(githubEnv.GITHUB_CLIENT_SECRET);
  });

  it("selects the immutable numeric GitHub id and discards the upstream token", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "private-upstream-token" }))
      .mockResolvedValueOnce(Response.json({ id: 54321, login: "home-owner", name: "A Person" }));
    vi.stubGlobal("fetch", fetch);
    const result = await githubIdentity("callback-code", "pkce-verifier", githubEnv);
    expect(result).toEqual({ userId: "54321", login: "home-owner" });
    const [tokenUrl, tokenOptions] = fetch.mock.calls[0];
    expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(Object.fromEntries(tokenOptions.body as URLSearchParams)).toMatchObject({ code: "callback-code", code_verifier: "pkce-verifier", redirect_uri: "https://thermostat.example/callback" });
    expect(fetch.mock.calls[1]).toMatchObject(["https://api.github.com/user", { headers: { Authorization: "Bearer private-upstream-token" } }]);
    expect(JSON.stringify(result)).not.toContain("private-upstream-token");
  });

  it("does not request an identity after failed token exchange", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "bad_verification_code" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(githubIdentity("code", "verifier", githubEnv)).rejects.toThrow("GitHub sign-in failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { id: "54321", login: "home-owner" },
    { id: 1.5, login: "home-owner" },
    { id: Number.MAX_SAFE_INTEGER + 1, login: "home-owner" },
    { id: 54321 },
    { id: 54321, login: "<script>" },
    { id: 54321, login: "a".repeat(40) },
  ])("rejects invalid upstream user response %j", async user => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "upstream-token" })).mockResolvedValueOnce(Response.json(user));
    vi.stubGlobal("fetch", fetch);
    await expect(githubIdentity("code", "verifier", githubEnv)).rejects.toThrow("identity could not be verified");
  });
});
