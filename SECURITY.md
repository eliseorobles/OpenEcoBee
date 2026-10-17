# Security

OpenEcoBee uses the authority of each user's signed-in ecobee browser session. A client authorized to reach a write-enabled account can change its thermostats. The hosted browser integration is experimental and still requires live verification.

## Hosted service trust

GitHub sign-in identifies the OpenEcoBee account. Normal ecobee login and MFA happen separately in a Cloudflare-hosted browser. The service stores encrypted browser session state so it can reconnect later without asking for an ecobee developer key.

**Use an operator you trust.** The service holds the key needed to decrypt session state. An operator or attacker controlling the Worker, its secrets, or a live browser can use those ecobee sessions. Saved-state encryption limits exposure of stored data; it does not prevent the running service from reading it.

The standard ecobee portal sign-in also requests profile read/write and sign-in grant-management permissions. These are broader than the fixed thermostat tools exposed by this MCP. Encrypting the saved session does not reduce the underlying ecobee permissions.

Keep the initial user allowlist closed while testing. Verify that OAuth authorization, per-user browser state, write preferences, and disconnect actions are isolated between accounts before opening registration. A public deployment should have an operator contact and a clear privacy/data-retention policy.

Browser live-view links grant sensitive access to an active session. Keep them private, do not paste them into chat or issues, and finish or disconnect the session after setup. Never collect passwords, MFA codes, cookies, session tokens, or browser storage through MCP tools.

Disconnecting from OpenEcoBee removes its saved session state. It does not necessarily revoke a session that has already been copied. If exposure is suspected, revoke affected sessions through ecobee's account controls where available, reconnect with a fresh session, rotate affected Worker secrets, and review authorized MCP clients.

## Access and data

Writes require both the account permission and the client's `thermostat:write` OAuth scope. Enabling them permits authenticated MCP callers with that scope to change thermostat settings; it does not add a per-command human approval screen. Clients should still honor their user-authorization controls.

Tool results include household information such as thermostat names, temperatures, humidity, equipment state, and settings. The service operator, Cloudflare infrastructure, and connected MCP clients/providers process relevant data under their own policies. Do not log credentials or full ecobee account responses.

Store deployment secrets through Worker secret bindings. Keep local `.env`/`.dev.vars` files, `.openecobee`, raw network captures, and session fixtures out of Git, published artifacts, and issue attachments.

## Local development

Treat `.openecobee/profile` and any alternate browser profile as credentials. Use a dedicated profile, keep it out of shared/synced locations, and run only one process against it at a time. Sign in directly in the browser rather than through chat.

Prefer stdio. Local HTTP has no OAuth, binds to loopback, and must stay private. `--allow-writes` grants mutation access to clients reaching that local instance. An optional private tunnel has its own runtime API key and access permissions, which must be protected separately.

## Report a vulnerability

Do not post credentials or session files in a public issue. Use the repository's **Security → Report a vulnerability** flow when private reporting is enabled. If it is unavailable, open a minimal issue asking for a private contact without describing an exploit or sharing sensitive material.

Include the affected version, access required, impact, and a redacted reproduction. Reproduce with demo data or dedicated test accounts. Never request a contributor's live browser profile as a troubleshooting attachment.
