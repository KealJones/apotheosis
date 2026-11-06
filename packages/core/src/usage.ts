import { getDb } from './db.js';

/**
 * Log a tool or skill invocation to the tool_usage table.
 */
export function logUsage(kind: 'tool' | 'skill', name: string, argsSummary?: string, durationMs?: number): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO tool_usage (called_at, kind, name, args_summary, duration_ms) VALUES (?, ?, ?, ?, ?)`
    ).run(Math.floor(Date.now() / 1000), kind, name, argsSummary ?? null, durationMs ?? null);
  } catch {
    // Never let usage logging break actual tool execution
  }
}

/**
 * Summarize tool args for logging — strip large/sensitive fields, keep keys + small values.
 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length > 100) {
      parts.push(`${key}:"...(${value.length} chars)"`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}:[${value.length} items]`);
    } else {
      parts.push(`${key}:${JSON.stringify(value)}`);
    }
  }
  return parts.join(', ').slice(0, 500);
}

/**
 * Wrap a tool handler to automatically log its invocation and duration.
 * Uses `any` for handler types to avoid conflicts with the MCP SDK's strict literal types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tracked(toolName: string, handler: (...args: any[]) => any): (...args: any[]) => any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]) => {
    const start = Date.now();
    const toolArgs = args[0] ?? {};
    try {
      const result = await handler(...args);
      logUsage('tool', toolName, summarizeArgs(toolArgs), Date.now() - start);
      return result;
    } catch (err) {
      logUsage('tool', toolName, summarizeArgs(toolArgs), Date.now() - start);
      throw err;
    }
  };
}
