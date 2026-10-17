# Architecture

OpenEcoBee provides a Cloudflare-hosted MCP service and a local development server. Both use the authenticated ecobee web portal through a browser adapter. Neither requires an ecobee developer application or manually supplied ecobee API token.

## Hosted path

```text
ChatGPT ── HTTPS /mcp + OAuth ── Cloudflare Worker
                                      │
                         authenticated GitHub user identity
                                      │
                         per-user Durable Object/session
                                      │
                            validated thermostat action
                                      │
                         Cloudflare-hosted Chromium browser
                                      │
                         signed-in ecobee portal → thermostat
```

GitHub identifies an OpenEcoBee user and supports the MCP authorization flow. Ecobee authentication is separate: the user signs in normally in a hosted browser and completes any MFA. A browser live view allows that interaction without requiring a local companion.

Each user's browser state belongs to their own Durable Object. Saved session state is encrypted with AES-GCM before persistence. The encryption key is an operator-managed Worker secret; the running service can decrypt the state to use it. Encryption does not remove trust in the service operator or Cloudflare's browser/storage infrastructure.

Writes require both the account-page permission and a `thermostat:write` grant to the MCP client. Disconnecting ecobee removes the saved session and resets account write permissions. The deployment initially allows only the configured operator login while live behavior and isolation are verified. GitHub access tokens are used to verify identity and are not persisted.

## Portal adapter

The browser backend loads ecobee's web portal, locates its Angular application, and invokes the portal's existing `ecobeeAPI` service from inside the signed-in page. Credentials remain in the browser context rather than being copied into a separate ecobee API client. The adapter translates the small MCP operation set into portal calls.

This depends on undocumented application internals. A portal release can change service discovery, response shapes, or command behavior. Ecobee may reject cloud or automated browsers before login. The adapter must fail clearly when its assumptions no longer hold and does not bypass login, MFA, or access restrictions.

REA is an optional reference for investigating the browser application. It is not bundled or required at runtime.

## Control boundary

MCP exposes fixed thermostat operations, with no browser scripting, arbitrary HTTP requests, or unrestricted ecobee proxy:

- Reads are available to the connected account.
- Changes require writes to be enabled.
- Temperature holds last 1–24 hours and accept explicit Fahrenheit or Celsius units.
- Setpoints must fit the thermostat's reported limits and minimum heat/cool separation.
- Mode changes use a restricted enum.
- `resume_schedule` sends a request to end a hold.

The server reports accepted delivery separately from observed readback. A matching readback still does not establish physical HVAC behavior. Schedule resumption is explicitly unverified. Client-side authorization controls remain relevant even after the server owner or account user enables writes.

## Local development path

The Node.js server uses a dedicated persistent Playwright Chromium profile. The user signs in locally; the profile carries that session into later runs. An in-memory demo backend allows testing without an account.

Stdio is the default local transport. Protocol messages go to stdout and operational messages to stderr. Optional streamable HTTP binds only to `127.0.0.1:3000/mcp` with host/origin checks. This local endpoint has no public OAuth and must remain private. Use a private tunnel for optional ChatGPT testing; the hosted Worker is the public deployment path.

Local `--allow-writes` is an operator gate for that process. It does not add a per-command human approval screen or authenticate a client. The local profile path is selected by `--profile`, then `OPENECOBEE_PROFILE`, then `.openecobee/profile` relative to the current working directory.

## Verification status

Automated and demo checks do not prove that ecobee accepts a hosted browser or that a thermostat accepts commands. Before opening a deployment beyond its initial allowlist, verify the normal ecobee login, account isolation, a status read, a deliberate temporary hold, schedule resumption, and a tool call from ChatGPT. Record compatibility and failures without recording credentials or household identifiers.
