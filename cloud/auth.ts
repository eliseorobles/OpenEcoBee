export interface Identity { userId: string; login: string; csrf: string; exp: number }
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export function nonce(): string { return encode(crypto.getRandomValues(new Uint8Array(32))); }

async function key(secret: string) {
  if (secret.length < 32) throw new Error("Cookie secret is not configured.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(value: unknown, secret: string): Promise<string> {
  const body = encode(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}

export async function verify<T extends { exp: number }>(value: string | undefined, secret: string): Promise<T | null> {
  if (!value || value.length > 8192) return null;
  try {
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra !== undefined || !await crypto.subtle.verify("HMAC", await key(secret), decode(signature), encoder.encode(body))) return null;
    const result = JSON.parse(new TextDecoder().decode(decode(body))) as T;
    return typeof result.exp === "number" && result.exp > Date.now() ? result : null;
  } catch { return null; }
}

export function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function allowedLogin(login: string, allowed: string | undefined): boolean {
  const names = (allowed ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  return names.includes("*") || names.includes(login.toLowerCase());
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function page(title: string, body: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · OpenEcoBee</title><style>body{font:17px/1.6 system-ui;background:#f4f7f4;color:#183f31;margin:0}main{max-width:720px;margin:60px auto;padding:32px;background:white;border-radius:18px}h1{line-height:1.2}button,a.button{display:inline-block;border:0;border-radius:8px;background:#165c43;color:white;padding:12px 20px;font:inherit;cursor:pointer;text-decoration:none}a{color:#165c43}form{margin:18px 0}.muted{color:#536b60}code{overflow-wrap:anywhere}label{display:block}</style><main><p class="muted">OpenEcoBee · experimental</p><h1>${escapeHtml(title)}</h1>${body}</main></html>`, { headers: responseHeaders });
}

export async function githubIdentity(code: string, verifier: string, env: { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string; PUBLIC_ORIGIN: string }): Promise<{ userId: string; login: string }> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, code_verifier: verifier, redirect_uri: `${env.PUBLIC_ORIGIN}/callback` }), signal: AbortSignal.timeout(15000) });
  const token = await tokenResponse.json() as { access_token?: string };
  if (!tokenResponse.ok || !token.access_token) throw new Error("GitHub sign-in failed.");
  const userResponse = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "OpenEcoBee-MCP" }, signal: AbortSignal.timeout(15000) });
  const user = await userResponse.json() as { id?: number; login?: string };
  if (!userResponse.ok || !Number.isSafeInteger(user.id) || typeof user.login !== "string" || !/^[a-z\d-]{1,39}$/i.test(user.login)) throw new Error("GitHub identity could not be verified.");
  // Upstream GitHub access token is used only here and is never persisted.
  return { userId: String(user.id), login: user.login };
}

export async function githubUrl(state: string, verifier: string, env: { GITHUB_CLIENT_ID: string; PUBLIC_ORIGIN: string }) {
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.PUBLIC_ORIGIN}/callback`, scope: "read:user", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return url.href;
}
