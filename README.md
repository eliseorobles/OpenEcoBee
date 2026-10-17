# OpenEcoBee MCP

An open-source MCP server for controlling ecobee thermostats from ChatGPT. The Cloudflare deployment is designed to run entirely in the cloud: people connect their own ecobee account through a browser, without installing a local companion or obtaining an ecobee developer API key.

**Experimental.** The Cloudflare deployment, GitHub sign-in, ecobee login, restoring an encrypted session, and a real thermostat read through ChatGPT have been verified. Live temperature and HVAC changes have not been tested. Ecobee can block cloud browsers, and portal changes can break this unofficial integration.

The [operator's hosted pilot](https://openecobee-mcp.eliseo-492.workers.dev) is currently restricted to the operator's GitHub account. Other users can deploy their own instance using the guide below.

## What “no auth token” means

People do not need an ecobee developer application or manually copied access token. They still sign in to their own ecobee account and complete its normal multifactor authentication. The service saves the resulting browser session so later MCP calls can use it. This is authenticated access, with token handling kept out of the user's setup.

For the hosted service, users sign in with GitHub to identify their OpenEcoBee account and authorize the MCP connection. Ecobee login happens separately in a hosted browser. **The operator hosting OpenEcoBee is trusted with the ecobee session:** saved state is encrypted, but the running service has the key needed to decrypt it. See [security](SECURITY.md).

Ecobee's standard portal sign-in requests thermostat access, profile read/write access, and sign-in grant management. OpenEcoBee exposes only its fixed thermostat tools, but the saved portal session has these broader permissions.

Ecobee [currently does not accept new developer registrations](https://www.ecobee.com/en-us/developers/), so this project uses its signed-in web portal instead of requiring a developer API key.

## Hosted setup

The operator deploys the Worker and configures GitHub OAuth once. End users do not need Cloudflare accounts, server keys, or a process running on their computer.

1. Deploy the service using [the Cloudflare guide](docs/cloudflare.md).
2. Open the deployed `/app` page and sign in with GitHub.
3. Connect ecobee, complete the normal login/MFA in the hosted browser, and finish the connection.
4. Keep access read-only initially; enable thermostat changes in the account page when ready.
5. Add the deployed HTTPS `/mcp` endpoint to ChatGPT with OAuth. See [Connect ChatGPT](docs/chatgpt.md).

The deployment starts with a closed user allowlist. Verify login, account isolation, and a deliberate thermostat command before broadening access.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_thermostats` | List accessible thermostats and their identifiers. |
| `get_thermostat_status` | Read temperature, humidity, mode, connection state, and setpoints. |
| `set_temperature` | Set a temporary heating/cooling hold; accepts Fahrenheit or Celsius. |
| `set_hvac_mode` | Select `off`, `heat`, `cool`, or `auto`. |
| `resume_schedule` | End a hold and resume the thermostat's schedule. |

Changes require writes to be enabled. Holds last 1–24 hours; setpoints must fit the thermostat's reported limits and minimum heat/cool separation. A response distinguishes accepted delivery from observed readback. Always check a pending result before retrying a change. Schedule resumption is reported as accepted without claiming physical verification.

Example prompts:

- “List my thermostats and show the downstairs temperature.”
- “Set the downstairs heating setpoint to 68°F and cooling setpoint to 76°F for two hours.”
- “Resume the downstairs thermostat's schedule.”

## Local development

Use Node.js 22 or newer:

```sh
npm install
npm run check
npm test
npm run build
```

Try the simulated thermostat without an account:

```sh
npm run demo
# To exercise changes against the simulation:
node dist/cli.js serve --demo --allow-writes
```

The demo is a stdio MCP server and waits for a client. For a local real-account experiment, install Chromium and complete ecobee login on this computer:

```sh
npx playwright install chromium
node dist/cli.js login
node dist/cli.js status
node dist/cli.js serve
# Explicitly opt in to thermostat changes:
node dist/cli.js serve --allow-writes
```

Local state defaults to `.openecobee/profile`, relative to the working directory. Use `--profile /absolute/path/to/profile` or `OPENECOBEE_PROFILE` when a client launches the server from a different directory. Treat the directory as credentials and run only one process against it at a time.

A generic local MCP client can launch the server with:

```json
{
  "mcpServers": {
    "openecobee": {
      "command": "node",
      "args": [
        "/absolute/path/to/OpenEcoBee/dist/cli.js",
        "serve",
        "--profile",
        "/absolute/path/to/OpenEcoBee/.openecobee/profile"
      ]
    }
  }
}
```

For local HTTP, run `node dist/cli.js serve --transport http`. It listens at `http://127.0.0.1:3000/mcp`, with local host/origin checks. This local endpoint has no OAuth and must remain private. The hosted Worker has a separate authenticated deployment path.

## Project notes

The browser integration depends on ecobee portal internals. Login sessions can expire, cloud browsers can be rejected, and the adapter can stop working after a portal release. There is no offline control path.

See [architecture](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md). This is an independent MIT-licensed implementation inspired by [emrikol/ecobee-mcp](https://github.com/emrikol/ecobee-mcp); its code is not copied. [REA](https://github.com/morluto/rea/) is a reference for investigating browser applications, not a runtime dependency.

Not affiliated with or endorsed by ecobee, OpenAI, GitHub, or Cloudflare.
