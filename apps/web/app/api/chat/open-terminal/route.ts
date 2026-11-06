import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { findClaudeCli, repoRoot } from "@/lib/chat/env";
import { isCrossSiteRequest } from "@/lib/host-guard";

export const runtime = "nodejs";

const run = promisify(execFile);
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * POST { prompt } — opens Terminal.app in the repo with `claude '<prompt>'`.
 *
 * Writes a self-deleting `.command` file and hands it to `open -a Terminal`,
 * which runs it. Unlike `osascript -e 'tell app "Terminal"'`, this needs no
 * macOS Automation permission. The command is also returned so the UI can
 * offer copy-to-clipboard if the launch fails.
 */
export async function POST(request: Request) {
  if (isCrossSiteRequest(request)) return Response.json({ error: "Cross-site request refused" }, { status: 403 });

  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const command = `cd ${shellQuote(repoRoot())} && ${shellQuote(findClaudeCli() ?? "claude")}${prompt ? ` ${shellQuote(prompt)}` : ""}`;

  const file = path.join(tmpdir(), `apotheosis-claude-${randomUUID()}.command`);
  try {
    await writeFile(file, `#!/bin/zsh -l\nrm -f -- "$0"\n${command}\n`, { mode: 0o700 });
    await run("open", ["-a", "Terminal", file]);
    return Response.json({ ok: true, command });
  } catch (err) {
    return Response.json({ ok: false, command, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
