# Connect ChatGPT

Use the hosted Worker's HTTPS `/mcp` endpoint with OAuth. Each person authorizes their own OpenEcoBee account and connects their own ecobee session. No ecobee developer key or token copying is required.

These instructions follow [OpenAI's connect and test guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt), checked on October 17, 2026. Account access and workspace policies can affect availability. End-to-end verification is still required on the deployed service.

## Connect an account

1. Open the service's `/app` page and sign in with GitHub. The operator must allow your account during the initial rollout.
2. Choose the ecobee connection action. Complete your normal ecobee login and MFA directly in the hosted browser; keep its live-view URL private.
3. Finish the connection and check that thermostat status can be read. Enable writes in the account page only when ready to permit thermostat changes.
4. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**.
5. Enter a name such as “OpenEcoBee,” the deployed `https://YOUR_SERVICE/mcp` URL, and choose OAuth authentication. Review OpenEcoBee's requested scopes, then complete the GitHub sign-in using the same account as step 1. Keep `thermostat:read` selected; grant `thermostat:write` only if you want this client to make changes.
6. Review the discovered tools and choose **Create as a plugin**. Install it, then select it with `@` in a new chat.

Never paste ecobee passwords, MFA codes, browser cookies, or session tokens into ChatGPT. The hosted service stores your ecobee browser session; use a deployment whose operator you trust.

Writes need both the account-page permission and the client's `thermostat:write` grant. If you initially omitted that scope, reconnect/re-authorize the ChatGPT connection to grant it before making changes. `offline_access` permits continued access using refresh tokens; it does not keep an expired ecobee session signed in.

## Verify before relying on it

First ask: “List the thermostats available through OpenEcoBee.” Check the names and current temperatures against the ecobee app. After enabling writes, make a small temporary hold, verify the result on the device or app, then test `resume_schedule`.

A command can be accepted while readback is still pending. Check the actual state before retrying. A schedule-resume response does not by itself verify the active schedule.

After changes to tool descriptions or schemas, restart/redeploy the service, open the connection in [ChatGPT Plugins](https://chatgpt.com/plugins), select **Refresh**, and test again in a new conversation.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Your GitHub account cannot sign in | Ask the deployment operator to check the configured user allowlist. |
| ChatGPT cannot connect | Verify the deployed HTTPS `/mcp` URL, OAuth callback configuration, and Worker secrets. |
| ecobee login is required | Reconnect ecobee from `/app`; sessions can expire. |
| Hosted browser login is blocked | Ecobee may reject cloud/automated browsers. This deployment route needs live compatibility verification. |
| A change is rejected as read-only | Enable writes in `/app` and check that the MCP client's OAuth grant includes `thermostat:write`. |
| Portal service cannot be found | The unofficial portal adapter may need an update. |

## Optional local testing with a private tunnel

A developer can connect the local server without publishing its HTTP endpoint using OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). This is a separate local development route and requires the computer and tunnel client to remain running.

You need a tunnel ID from [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), an OpenAI runtime API key, Tunnels **Read + Use**, and permission to use custom MCP servers in the target ChatGPT workspace. Creating a tunnel also requires **Manage**. Associate it with the correct Platform organization and ChatGPT workspace.

Download the client through Platform settings or the [official latest release](https://github.com/openai/tunnel-client/releases/latest), then check `tunnel-client help quickstart`. Supply `CONTROL_PLANE_API_KEY` locally through your environment or secret manager, keeping its value out of chat, shell history, and shared files. Adapt the documented example:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile openecobee \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command 'node /absolute/path/to/OpenEcoBee/dist/cli.js serve --demo'

tunnel-client doctor --profile openecobee --explain
tunnel-client run --profile openecobee
```

In ChatGPT, choose **Tunnel** under **Connection** and select the same tunnel. Start with the demo. For a real local session, remove `--demo` and append `--profile /absolute/path/to/OpenEcoBee/.openecobee/profile`, using the same profile as `login`. Add `--allow-writes` only when ready.

Keep the tunnel client running. Do not expose the unauthenticated local HTTP endpoint through a public forwarding URL.
