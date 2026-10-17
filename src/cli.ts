#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Controller } from "./controller.js";
import { DemoBackend } from "./demo.js";
import { BrowserBackend, login } from "./browser.js";
import { serveHttp, serveStdio } from "./server.js";
import { UserError, type ThermostatBackend } from "./types.js";

const help = `OpenEcoBee — ecobee MCP through your local browser sign-in

Usage: openecobee [login|status|serve] [options]
  --demo                 Use a simulated thermostat; no account or browser
  --allow-writes         Enable thermostat changes (default: read-only)
  --transport stdio|http MCP transport (default: stdio)
  --port 3000            HTTP port, on 127.0.0.1 only
  --profile PATH         Dedicated browser profile (default: .openecobee/profile)
  --headed               Show browser while serving/status
  --help                 Show this help

Sign in through the browser window. Never put credentials in chat.
HTTP is local only. Use a private MCP tunnel to connect ChatGPT.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { demo: { type: "boolean", default: false }, "allow-writes": { type: "boolean", default: false }, transport: { type: "string", default: "stdio" }, port: { type: "string", default: "3000" }, profile: { type: "string" }, headed: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? "serve";
  if (positionals.length > 1 || !["login", "status", "serve"].includes(command)) throw new UserError("Unknown command. Use --help.");
  if (!["stdio", "http"].includes(values.transport)) throw new UserError("Transport must be stdio or http.");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("Port must be between 1 and 65535.");
  const profileDir = resolve(values.profile ?? process.env.OPENECOBEE_PROFILE ?? ".openecobee/profile");
  if (command === "login") {
    if (values.demo) throw new UserError("Demo mode does not need a login.");
    console.error("Sign in directly in the ecobee browser window, including any MFA prompt. The dedicated profile saves your local session.");
    await login(profileDir);
    console.error("Sign-in verified. Run openecobee status to check your thermostats.");
    return;
  }
  const backend: ThermostatBackend = values.demo ? new DemoBackend() : new BrowserBackend({ profileDir, headless: !values.headed });
  const controller = new Controller(backend, values["allow-writes"]);
  if (command === "status") { try { console.log(JSON.stringify(await controller.list(), null, 2)); } finally { await backend.close(); } return; }
  const transport = values.transport === "http" ? await serveHttp(controller, port) : await serveStdio(controller);
  console.error(`OpenEcoBee ${values.demo ? "DEMO" : "browser"} server ready (${values["allow-writes"] ? "writes enabled" : "read-only"})${values.transport === "http" ? ` at http://127.0.0.1:${port}/mcp` : " over stdio"}.`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>(done => { if ("listen" in transport) transport.close(() => done()); else void transport.close().then(done); });
    await backend.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  if (values.transport === "stdio") process.stdin.once("end", () => void close());
}

main().catch(error => { console.error(error instanceof UserError ? error.message : "OpenEcoBee could not start. Check the local browser installation, profile access, and command options."); process.exitCode = 1; });
