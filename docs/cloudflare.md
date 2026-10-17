# Deploy on Cloudflare

This is the fully hosted path: the operator runs the MCP service and browsers on Cloudflare, and users connect their own ecobee accounts. No local companion remains running for end users.

**Experimental deployment.** The operator's Cloudflare instance has passed GitHub sign-in, ecobee login, restoring and renewing the encrypted browser session, a thermostat read through ChatGPT's installed custom MCP plugin, and a real indefinite cooling hold with matching readback. Independent deployments still need their own verification. HVAC mode changes remain independently unverified live. Ecobee may reject Cloudflare-hosted browsers; a successful build alone does not establish compatibility.

## Operator requirements

- A Cloudflare account with Workers, Workers KV, Durable Objects, and Browser Run access. Review current [browser pricing](https://developers.cloudflare.com/browser-run/pricing/) and [limits](https://developers.cloudflare.com/browser-run/limits/) before inviting users.
- Node.js 22 or newer and access to deploy the Worker.
- A GitHub OAuth App owned by the operator. Users need a GitHub account, but do not create OAuth Apps themselves.
- A stable HTTPS origin for the service, either `workers.dev` or your own domain.

The deployment uses `BROWSER` for the cloud browser binding, `THERMOSTAT_SESSIONS` for per-user Durable Objects, and `OAUTH_KV` for OAuth state. Do not rename the bindings without updating the code.

## 1. Install and configure storage

```sh
npm install
npm run check
npm run check:cloud
npm test
npm run build
npm run deploy:dry
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

In `wrangler.jsonc`, replace `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` with the new namespace ID. Change the Worker `name` if needed. Keep the Durable Object migration: it provisions the `ThermostatSession` class on deployment. See Cloudflare's [KV setup guide](https://developers.cloudflare.com/kv/get-started/) for the namespace/binding workflow.

`ALLOWED_GITHUB_USERS` defaults to `eliseorobles`, allowing only that operator account. Replace it with your own comma-separated GitHub logins for an independent deployment; an empty value denies access. After live verification and a review of operating costs, `*` permits all GitHub users. Keep the initial test limited until the checks below pass.

## 2. Set the public origin and GitHub OAuth App

Deploy once to obtain the Worker's `workers.dev` URL if you do not already know your final origin:

```sh
npx wrangler deploy
```

The initial deployment is not usable until the secrets and OAuth settings are added. Set `PUBLIC_ORIGIN` in `wrangler.jsonc` to the final HTTPS origin without a trailing slash, for example `https://openecobee-mcp.YOUR_SUBDOMAIN.workers.dev`. Use the same origin consistently in ChatGPT, GitHub, and service configuration.

Create a GitHub OAuth App for this deployment:

| GitHub setting | Value |
| --- | --- |
| Homepage URL | `https://YOUR_SERVICE` |
| Authorization callback URL | `https://YOUR_SERVICE/callback` |

The operator supplies this app's Client ID and Client Secret in the next step. Users authorize the app; they do not create their own OAuth App.

## 3. Add secrets

Use Cloudflare's [secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/) rather than committing values:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Enter each value at the prompt. Generate independent random secrets directly into Wrangler without printing them:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put COOKIE_SECRET
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put SESSION_ENCRYPTION_KEY
```

`SESSION_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. It encrypts saved ecobee browser state using AES-GCM with a user binding. Store a secure backup if you need to preserve existing connections. Replacing it makes existing saved state unreadable and requires affected users to reconnect ecobee. Keep all secrets separate from source control, issue reports, and chat.

Redeploy after setting the origin and allowlist:

```sh
npx wrangler deploy
```

## 4. Verify the hosted account flow

1. Open `https://YOUR_SERVICE/app` and sign in with an allowed GitHub account.
2. Start ecobee connection. Open the generated private browser live view and complete normal ecobee login and MFA. Treat the link as a credential; [Cloudflare's Live View documentation](https://developers.cloudflare.com/browser-run/features/live-view/) explains its signed access URLs.
3. Finish connecting and confirm that status can be read. Keep writes disabled initially.
   Use **Check connection** to verify a fresh hosted browser can restore the saved session and read thermostat data after the sign-in browser closes.
4. Enable writes for this account and grant `thermostat:write` to the test MCP client. Make a deliberate temporary hold and verify the thermostat or ecobee app reflects it. Test schedule resumption separately.
5. Disconnect and confirm the account no longer has usable saved ecobee access through the service.
6. Use a second allowed test identity to verify that users cannot access each other's browser state, thermostat data, or write preferences.
7. Follow [Connect ChatGPT](chatgpt.md) and verify a tool call through OAuth at the deployed `/mcp` endpoint.

Record actual results. A browser launch is not proof of ecobee login; an accepted command is not proof of device behavior. If ecobee blocks cloud browsers, the fully hosted approach remains blocked until a supported integration path is established.

## Operating a public instance

Keep ecobee sessions and signed live-view URLs out of logs. The repository disables Worker observability by default to reduce accidental request logging; review any logging you enable. Give users an operator contact and clear retention/privacy information before expanding access.

Users trust the operator with decryptable ecobee session state, even though they never copy an ecobee token. Keep the initial allowlist while testing, monitor Cloudflare browser usage and limits, and validate disconnect/reconnect behavior after portal or dependency changes. See [SECURITY.md](../SECURITY.md).

The local Node HTTP server is a separate development transport without OAuth. Do not use a public forwarding URL to expose it as a substitute for this authenticated Worker.
