import { ClaudeCliNotFoundError, runTurn } from "@/lib/chat/agent";
import type { ChatEvent } from "@/lib/chat/protocol";
import { isCrossSiteRequest } from "@/lib/host-guard";

// Spawns the claude CLI and the MCP server as child processes.
export const runtime = "nodejs";

/**
 * POST { prompt, sessionId? } -> NDJSON stream of ChatEvents. One request per
 * turn; pass back the `session` event's id to continue the conversation.
 */
export async function POST(request: Request) {
  if (isCrossSiteRequest(request)) return Response.json({ error: "Cross-site request refused" }, { status: 403 });

  let body: { prompt?: unknown; sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return Response.json({ error: "Missing 'prompt' string" }, { status: 400 });
  }
  const prompt = body.prompt;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: ChatEvent) => {
        if (open) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await runTurn({ prompt, sessionId, signal: request.signal, emit });
      } catch (err) {
        if (!request.signal.aborted) emit({ type: "error", ...describeError(err) });
      } finally {
        emit({ type: "done" });
        open = false;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function describeError(err: unknown): { message: string; authProblem?: boolean } {
  if (err instanceof ClaudeCliNotFoundError) {
    return { message: "The `claude` CLI isn't installed or isn't on PATH. Install Claude Code, then run `claude` and log in." };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/auth|login|credential|401|oauth/i.test(message)) {
    return { authProblem: true, message: "Claude login problem. Run `claude` in a terminal and log in again." };
  }
  return { message };
}
