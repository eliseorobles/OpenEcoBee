# Contributing

OpenEcoBee is an early, independent project. Useful contributions include better portal compatibility, clearer setup errors, transport verification, and documentation based on observed device behavior.

## Local development

Use Node.js 22 or newer:

```sh
npm install
npx playwright install chromium
npm run check
npm run check:cloud
npm test
npm run build
npm run deploy:dry
```

Use `npm run demo` to exercise the MCP server without an ecobee account. Writes are disabled by default; pass `--allow-writes` explicitly when testing the simulated mutation tools.

For hosted work, read [the Cloudflare deployment guide](docs/cloudflare.md). Keep a test deployment on a closed user allowlist. OAuth, Cloudflare browser compatibility, account isolation, and end-to-end ChatGPT calls need integration checks in addition to the demo tests.

## Changes

Keep the MCP operation set small and its input schemas explicit. Add meaningful tests for validation or behavior changes. Avoid tests that require credentials, cloud access, or a real thermostat. The browser backend should return useful errors when the portal no longer matches its assumptions.

Keep local operational logs on stderr. Never log browser cookies, authorization headers, passwords, MFA codes, complete browser storage, or account responses containing private data. Do not add session files, browser profiles, live-view URLs, or Worker secrets as fixtures. See [SECURITY.md](SECURITY.md).

Contributions should be your own work or have a compatible license and clear attribution. Do not copy GPL-licensed implementations into this MIT-licensed project.

## Live verification

Only test an account and thermostat you are authorized to control. Complete login normally, in the hosted browser or project's dedicated local profile. Read status first. Enable writes only for a deliberate test, observe a temporary hold on the device or ecobee app, then verify schedule resumption. Keep the thermostat within suitable settings for the property and occupants.

For hosted changes, use two test identities to verify that one user's OAuth connection, browser state, and write preference cannot access or change another user's thermostat. Test the denied allowlist path, expired ecobee session, and disconnect behavior before inviting more users.

In a pull request, distinguish automated/demo checks from live checks. For a live result, describe the operation, whether the physical or app state matched, and any portal incompatibility. Omit thermostat IDs, addresses, credentials, screenshots containing account details, and browser session files.

## Reporting bugs

Include the Node.js version, operating system, command or MCP tool, expected behavior, and a redacted error. State whether demo mode works and whether the issue occurs before or after normal ecobee login. Never attach `.openecobee`, a persistent Chromium profile, or raw network captures. Security issues should follow the private reporting guidance in [SECURITY.md](SECURITY.md).
