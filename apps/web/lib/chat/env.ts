import "server-only";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Repo root: the nearest ancestor of the server's cwd holding pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
}

export function mcpServerPath(): string {
  return path.join(repoRoot(), "apps", "mcp", "dist", "server.js");
}

/**
 * The installed `claude` CLI. PATH first, then the usual install locations,
 * since a dev server launched from launchd/a GUI often has a minimal PATH.
 */
export function findClaudeCli(): string | null {
  const candidates = [
    process.env.APOTHEOSIS_CLAUDE_PATH,
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => d && path.join(d, "claude")),
    path.join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? null;
}

/**
 * Env for spawning the CLI. It must use its own stored OAuth login (keychain),
 * never an API key, and must not inherit a parent Claude Code session's env
 * when the dev server was launched from inside one.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ANTHROPIC_API_KEY")
  ) as NodeJS.ProcessEnv;
}
