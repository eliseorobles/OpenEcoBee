import type { Page, Request, Response } from "@cloudflare/playwright";

type Kind = "thermostat" | "summary" | "auth";
type Sample = {
  kind: Kind;
  method: "GET" | "POST";
  http: number | null;
  api: number | null;
  body: "json" | "html" | "other";
  failed: boolean;
  complete: boolean;
};
type Health = {
  storeReady: boolean;
  bootstrapComplete: boolean;
  bootstrapSuccess: boolean;
  reduxTokenExists: boolean;
  auth0CookieExists: boolean;
  reduxTokenMatchesCookie: boolean;
  reduxJwtExpiryKnown: boolean;
  reduxJwtExpired: boolean;
  cookieJwtExpiryKnown: boolean;
  cookieJwtExpired: boolean;
};

/** Collect only fixed categories and status codes; never retain network data. */
export function capturePortalDiagnostics(page: Page): { summary(): Promise<string>; dispose(): void } {
  const samples: Sample[] = [];
  const pending = new Set<Promise<void>>();
  let disposed = false;
  let result: Promise<string> | undefined;

  const classify = (request: Request): Pick<Sample, "kind" | "method"> | null => {
    try {
      const method = request.method();
      if (method !== "GET" && method !== "POST") return null;
      const url = new URL(request.url());
      if (url.protocol !== "https:") return null;
      if (url.hostname === "api.ecobee.com" && url.pathname === "/1/thermostat") return { kind: "thermostat", method };
      if (url.hostname === "api.ecobee.com" && url.pathname === "/1/thermostatSummary") return { kind: "summary", method };
      if (url.hostname === "auth.ecobee.com" && url.pathname === "/authorize") return { kind: "auth", method };
    } catch { /* A malformed request cannot enter the diagnostic output. */ }
    return null;
  };
  const reserve = (request: Request): Sample | null => {
    if (disposed || samples.length >= 8) return null;
    const classification = classify(request);
    if (!classification) return null;
    const sample: Sample = { ...classification, http: null, api: null, body: "other", failed: false, complete: false };
    samples.push(sample);
    return sample;
  };
  const observe = async (response: Response, sample: Sample): Promise<void> => {
    try {
      const status = response.status();
      if (Number.isInteger(status) && status >= 100 && status <= 599) sample.http = status;
      // Read exactly this header; never enumerate authorization/cookie headers.
      const type = (await response.headerValue("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      sample.body = type === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type)
        ? "json" : type === "text/html" || type === "application/xhtml+xml" ? "html" : "other";
      // Auth responses can contain credentials. Their bodies are never read.
      if (sample.kind !== "auth" && sample.body === "json") {
        const value: unknown = await response.json();
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const statusValue = (value as { status?: unknown }).status;
          if (statusValue !== null && typeof statusValue === "object" && !Array.isArray(statusValue)) {
            const code = (statusValue as { code?: unknown }).code;
            if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 9999) sample.api = code;
          }
        }
      }
    } catch { /* No raw browser, response, or parsing exception is retained. */ }
    finally { sample.complete = true; }
  };
  const onResponse = (response: Response): void => {
    try {
      const sample = reserve(response.request());
      if (!sample) return;
      const work = observe(response, sample);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    } catch { /* Event handlers must not propagate browser errors. */ }
  };
  const onFailed = (request: Request): void => {
    try {
      const sample = reserve(request);
      if (sample) { sample.failed = true; sample.complete = true; }
      // Deliberately do not inspect failure().errorText, which can contain URLs.
    } catch { /* Only the fixed failed flag is exposed. */ }
  };
  try {
    page.on("response", onResponse);
    page.on("requestfailed", onFailed);
  } catch { /* summary() still returns bounded unavailable health if detached. */ }

  const dispose = (): void => {
    disposed = true;
    try { page.off("response", onResponse); } catch { /* No raw errors. */ }
    try { page.off("requestfailed", onFailed); } catch { /* No raw errors. */ }
  };
  const summarize = async (): Promise<string> => {
    let health: Health | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const healthWork = page.evaluate(() => {
        try {
          const store = (window as Window & { ecobeeStore?: { getState(): {
            tokens?: { token?: unknown };
            lifecycle?: { isBootstrapComplete?: unknown; isBootstrapSuccess?: unknown };
          } } }).ecobeeStore;
          const state = typeof store?.getState === "function" ? store.getState() : undefined;
          const token = typeof state?.tokens?.token === "string" ? state.tokens.token : "";
          const pair = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("_TOKEN="));
          const cookieToken = pair ? pair.slice("_TOKEN=".length) : "";
          const expiry = (value: string): { known: boolean; expired: boolean } => {
            try {
              const parts = value.split(".");
              if (parts.length !== 3 || !parts[1]) return { known: false, expired: false };
              const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
              const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as { exp?: unknown };
              const known = typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0;
              return { known, expired: known && (claims.exp as number) * 1000 <= Date.now() };
            } catch { return { known: false, expired: false }; }
          };
          const reduxExpiry = expiry(token);
          const cookieExpiry = expiry(cookieToken);
          // JWT claims are diagnostic hints only, never authorization decisions.
          return {
            storeReady: Boolean(state),
            bootstrapComplete: state?.lifecycle?.isBootstrapComplete === true,
            bootstrapSuccess: state?.lifecycle?.isBootstrapSuccess === true,
            reduxTokenExists: Boolean(token),
            auth0CookieExists: Boolean(cookieToken),
            reduxTokenMatchesCookie: Boolean(token && cookieToken && token === cookieToken),
            reduxJwtExpiryKnown: reduxExpiry.known,
            reduxJwtExpired: reduxExpiry.expired,
            cookieJwtExpiryKnown: cookieExpiry.known,
            cookieJwtExpired: cookieExpiry.expired,
          };
        } catch { return null; }
      }).then(value => {
        if (finished || !value || !Object.values(value).every(field => typeof field === "boolean")) return;
        health = value;
      }).catch(() => undefined);
      // Both health evaluation and already observed network bodies share the
      // same one-second deadline. Unfinished bodies are labelled pending.
      await Promise.race([
        Promise.allSettled([healthWork, ...pending]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
      ]);
    } catch { /* Keep the fixed unavailable result. */ }
    finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      dispose();
    }
    const yes = (value: boolean): string => value ? "yes" : "no";
    const healthText = health
      ? `store=${yes(health.storeReady)},bootstrap=${yes(health.bootstrapComplete)},success=${yes(health.bootstrapSuccess)},token=${yes(health.reduxTokenExists)},cookie=${yes(health.auth0CookieExists)},equal=${yes(health.reduxTokenMatchesCookie)},tokenExpired=${health.reduxJwtExpiryKnown ? yes(health.reduxJwtExpired) : "unknown"},cookieExpired=${health.cookieJwtExpiryKnown ? yes(health.cookieJwtExpired) : "unknown"}`
      : "health=unavailable";
    const network = samples.map(sample => sample.failed
      ? `${sample.kind}/${sample.method}/failed`
      : `${sample.kind}/${sample.method}/http=${sample.http ?? "none"}/api=${sample.api ?? "none"}/${sample.body}${sample.complete ? "" : "/pending"}`).join(";") || "none";
    return `Portal diagnostics: ${healthText}; network=${network}.`;
  };
  return { summary: () => result ??= summarize(), dispose };
}
