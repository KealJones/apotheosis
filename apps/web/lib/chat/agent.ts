import "server-only";

import { randomUUID } from "node:crypto";

import {
  query,
  type HookCallback,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { cleanEnv, findClaudeCli, mcpServerPath, repoRoot } from "@/lib/chat/env";
import { isReadOnlyTool, type ChatEvent } from "@/lib/chat/protocol";

/**
 * Pending write-tool confirmations, keyed by requestId. Kept on globalThis
 * because Next bundles each route handler separately: /api/chat creates the
 * entry and /api/chat/permission resolves it, so module-level state would not
 * be shared between them.
 */
type Pending = { resolve: (allowed: boolean) => void };
const g = globalThis as { __apotheosisChatPending?: Map<string, Pending> };
const pending = (g.__apotheosisChatPending ??= new Map());

export function resolvePermission(requestId: string, allowed: boolean): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  entry.resolve(allowed);
  return true;
}

export class ClaudeCliNotFoundError extends Error {}

interface RunTurnArgs {
  prompt: string;
  sessionId?: string;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
}

/**
 * Runs one chat turn through the Agent SDK and translates SDK messages into
 * ChatEvents. Resolves when the turn finishes (or is aborted).
 *
 * Why the installed CLI and not the SDK's bundled binary: on this machine's
 * managed settings (`allowManagedMcpServersOnly`), the bundled binary drops
 * the stdio server with "MCP server blocked by enterprise policy", while the
 * installed CLI registers it. See tasks/notes/b7-agent-sdk-spike.md.
 */
export async function runTurn({ prompt, sessionId, signal, emit }: RunTurnArgs): Promise<void> {
  const cli = findClaudeCli();
  if (!cli) throw new ClaudeCliNotFoundError("Could not find the `claude` CLI.");

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  // Tool-use ids the user approved. canUseTool (below) is only a backstop and
  // refuses any gated tool the PreToolUse hook did not approve.
  const approved = new Set<string>();

  // The gate. PreToolUse hooks run for every tool call regardless of
  // permission mode or settings allow-rules (a developer's local settings may
  // set defaultMode: bypassPermissions), so the confirmation lives here
  // rather than relying on canUseTool being reached.
  const gate: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const allow = (reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, permissionDecisionReason: reason },
    });
    if (isReadOnlyTool(input.tool_name)) return allow("read-only tool");

    const requestId = randomUUID();
    const toolCallId = toolUseID ?? input.tool_use_id;
    emit({ type: "permission_request", requestId, toolCallId, name: input.tool_name, input: input.tool_input });
    const allowed = await new Promise<boolean>((resolve) => {
      pending.set(requestId, { resolve });
      abortController.signal.addEventListener("abort", () => resolve(false), { once: true });
    });
    pending.delete(requestId);
    emit({ type: "permission_resolved", requestId, allowed });

    if (!allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: "The user declined this action in the chat UI.",
        },
      };
    }
    approved.add(toolCallId);
    return allow("approved by the user in the chat UI");
  };

  // Streaming input is what lets canUseTool/hooks run. The generator yields the
  // single user message and then stays open until the turn's result arrives.
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      session_id: sessionId ?? "",
      parent_tool_use_id: null,
      message: { role: "user", content: prompt },
    };
    await finished;
  }

  const q = query({
    prompt: input(),
    options: {
      cwd: repoRoot(),
      pathToClaudeCodeExecutable: cli,
      env: cleanEnv(),
      abortController,
      resume: sessionId,
      settingSources: ["project"],
      skills: "all",
      // No shell, no file writes, no web. Everything the chat needs goes
      // through the Apotheosis MCP server.
      tools: ["Read", "Glob", "Grep", "Skill", "ToolSearch"],
      strictMcpConfig: true,
      mcpServers: {
        apotheosis: {
          type: "stdio",
          command: process.execPath,
          args: [mcpServerPath()],
          // Blocks startup until connected so the tools exist on turn 1
          // (this was the spike's "stuck pending" failure) and skips the
          // ToolSearch round-trip.
          alwaysLoad: true,
          ...(process.env.DATA_DIR ? { env: { DATA_DIR: process.env.DATA_DIR } } : {}),
        },
      },
      permissionMode: "default",
      hooks: { PreToolUse: [{ hooks: [gate], timeout: 60 * 60 }] },
      canUseTool: async (name, toolInput, { toolUseID }) =>
        isReadOnlyTool(name) || approved.has(toolUseID)
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "Not approved in the chat UI." },
      // Draws on the user's Claude subscription, not API billing: keep it lean.
      effort: "low",
      maxTurns: 12,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are the chat panel inside the Apotheosis dashboard. Answer from the user's captured data via the mcp__apotheosis__* tools; never guess. Be concise.",
      },
    },
  });

  try {
    for await (const message of q) {
      translate(message, emit);
      if (message.type === "result") break;
    }
  } finally {
    finish();
    signal.removeEventListener("abort", onAbort);
    q.close();
  }
}

function translate(message: SDKMessage, emit: (event: ChatEvent) => void): void {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") emit({ type: "session", sessionId: message.session_id });
      return;
    case "assistant": {
      if (message.error === "authentication_failed") {
        emit({ type: "error", authProblem: true, message: "Claude login expired. Run `claude` in a terminal and log in again." });
        return;
      }
      for (const block of message.message.content) {
        if (block.type === "text") emit({ type: "text", text: block.text });
        else if (block.type === "tool_use") emit({ type: "tool_call", id: block.id, name: block.name, input: block.input });
      }
      return;
    }
    case "user": {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        emit({
          type: "tool_result",
          id: block.tool_use_id,
          content: stringifyToolResult(block.content),
          isError: Boolean(block.is_error),
        });
      }
      return;
    }
    case "result":
      if (message.subtype !== "success") {
        emit({ type: "error", message: `Turn ended: ${message.subtype}${"errors" in message ? ` (${message.errors.join("; ")})` : ""}` });
      }
      return;
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n");
  }
  return JSON.stringify(content);
}
