// Wire protocol between /api/chat (NDJSON stream, one event per line) and the
// chat UI. Client-safe: no server imports.

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "permission_request"; requestId: string; toolCallId: string; name: string; input: unknown }
  | { type: "permission_resolved"; requestId: string; allowed: boolean }
  | { type: "error"; message: string; authProblem?: boolean }
  | { type: "done" };

const MCP_PREFIX = "mcp__apotheosis__";

/**
 * Apotheosis tools that only read. These auto-approve; every other tool call
 * (Apotheosis writes, and anything not on this list, including tools added to
 * the MCP server later) requires an explicit in-chat confirmation. Allowlisting
 * reads rather than denylisting writes means a new write tool is gated by
 * default instead of silently running.
 */
const READ_ONLY_APOTHEOSIS_TOOLS = new Set([
  "recent_activity",
  "summarize_window",
  "list_ideas",
  "standup_draft",
  "code_time",
  "mentions",
  "triage_samples",
  "get_project",
  "get_inbox",
  "context_timeline",
  "slack_search",
  "usage_stats",
  "evidence_report",
  "list_meetings",
  "get_meeting",
  "search_meetings",
]);

/** Built-in agent tools that are safe to run unprompted (no writes, no shell). */
const READ_ONLY_BUILTINS = new Set(["Read", "Glob", "Grep", "Skill", "ToolSearch"]);

export function isReadOnlyTool(toolName: string): boolean {
  if (toolName.startsWith(MCP_PREFIX)) {
    return READ_ONLY_APOTHEOSIS_TOOLS.has(toolName.slice(MCP_PREFIX.length));
  }
  return READ_ONLY_BUILTINS.has(toolName);
}

/** `mcp__apotheosis__recent_activity` -> `recent_activity`, for display. */
export function displayToolName(toolName: string): string {
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}
