import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { cleanEnv, findClaudeCli, mcpServerPath, repoRoot } from "@/lib/chat/env";

export const runtime = "nodejs";

const run = promisify(execFile);
const RELOGIN = "Run `claude` in a terminal and log in again.";

export interface ChatHealth {
  ok: boolean;
  /** Human-readable next step when !ok. */
  message?: string;
  cli: { path: string | null; version?: string };
  auth: { loggedIn: boolean; authMethod?: string; subscriptionType?: string };
  mcp: { built: boolean; depsInstalled: boolean };
}

/**
 * Cheap readiness check for the chat: no inference, so it costs no usage.
 * Auth comes from `claude auth status`, which reads the CLI's stored
 * (keychain) login. An unset ANTHROPIC_API_KEY is expected, not an error.
 */
export async function GET() {
  const cliPath = findClaudeCli();
  const health: ChatHealth = {
    ok: false,
    cli: { path: cliPath },
    auth: { loggedIn: false },
    mcp: {
      built: existsSync(mcpServerPath()),
      depsInstalled: existsSync(path.join(repoRoot(), "apps", "mcp", "node_modules", "@modelcontextprotocol", "sdk")),
    },
  };

  if (!cliPath) {
    health.message = "The `claude` CLI isn't installed or isn't on PATH. Install Claude Code, then run `claude` and log in.";
    return Response.json(health);
  }

  const opts = { env: cleanEnv(), timeout: 10_000 };
  try {
    health.cli.version = (await run(cliPath, ["--version"], opts)).stdout.trim();
    const status = JSON.parse((await run(cliPath, ["auth", "status"], opts)).stdout) as ChatHealth["auth"];
    health.auth = { loggedIn: Boolean(status.loggedIn), authMethod: status.authMethod, subscriptionType: status.subscriptionType };
  } catch {
    // `auth status` exits non-zero when logged out; either way the fix is the same.
  }

  if (!health.auth.loggedIn) health.message = `Claude isn't logged in. ${RELOGIN}`;
  else if (!health.mcp.depsInstalled) health.message = "The Apotheosis MCP server's dependencies aren't installed. Run `pnpm install` at the repo root.";
  else if (!health.mcp.built) health.message = "The Apotheosis MCP server isn't built. Run `pnpm --filter apotheosis-mcp build`.";
  else health.ok = true;

  return Response.json(health);
}
