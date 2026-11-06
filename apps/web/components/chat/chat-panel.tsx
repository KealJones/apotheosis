"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Square, SquareTerminal } from "lucide-react";

import { ToolCallCard, type ToolPart } from "@/components/chat/tool-call-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatEvent } from "@/lib/chat/protocol";

type Part = { kind: "text"; text: string } | ToolPart;
type Message = { role: "user"; text: string } | { role: "assistant"; parts: Part[]; error?: string };

interface Health {
  ok: boolean;
  message?: string;
}

/** Applies one stream event to the in-progress assistant message. */
function applyEvent(parts: Part[], ev: ChatEvent): Part[] {
  const updateTool = (id: string, patch: (t: ToolPart) => Partial<ToolPart>) =>
    parts.map((p) => (p.kind === "tool" && p.id === id ? { ...p, ...patch(p) } : p));
  switch (ev.type) {
    case "text":
      return [...parts, { kind: "text", text: ev.text }];
    case "tool_call":
      return [...parts, { kind: "tool", id: ev.id, name: ev.name, input: ev.input }];
    case "tool_result":
      return updateTool(ev.id, () => ({ result: ev.content, isError: ev.isError }));
    case "permission_request": {
      const permission = { requestId: ev.requestId, state: "pending" as const };
      // The hook can fire before the tool_use block reaches us; create the card if needed.
      return parts.some((p) => p.kind === "tool" && p.id === ev.toolCallId)
        ? updateTool(ev.toolCallId, () => ({ permission }))
        : [...parts, { kind: "tool", id: ev.toolCallId, name: ev.name, input: ev.input, permission }];
    }
    case "permission_resolved":
      return parts.map((p) =>
        p.kind === "tool" && p.permission?.requestId === ev.requestId
          ? { ...p, permission: { ...p.permission, state: ev.allowed ? "allowed" : "denied" } }
          : p
      );
    default:
      return parts;
  }
}

export function ChatPanel({ initialPrompt = "" }: { initialPrompt?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [terminalNote, setTerminalNote] = useState<string | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Readiness only (no inference, no usage). The chat itself stays inert until Send.
  useEffect(() => {
    fetch("/api/chat/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, message: "Couldn't reach /api/chat/health." }));
  }, []);

  // Braces matter: newer browsers return a Promise from scrollIntoView, which
  // React would reject as an effect cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const patchLast = (fn: (m: Extract<Message, { role: "assistant" }>) => Partial<Extract<Message, { role: "assistant" }>>) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      if (!last || last.role !== "assistant") return ms;
      return [...ms.slice(0, -1), { ...last, ...fn(last) }];
    });

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setMessages((ms) => [...ms, { role: "user", text: prompt }, { role: "assistant", parts: [] }]);
    abort.current = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, sessionId: sessionId.current }),
        signal: abort.current.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const ev = JSON.parse(buf.slice(0, nl)) as ChatEvent;
          buf = buf.slice(nl + 1);
          if (ev.type === "session") sessionId.current = ev.sessionId;
          else if (ev.type === "error") patchLast(() => ({ error: ev.message }));
          else patchLast((m) => ({ parts: applyEvent(m.parts, ev) }));
        }
      }
    } catch (err) {
      if (!abort.current?.signal.aborted) patchLast(() => ({ error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  async function answer(requestId: string, allow: boolean) {
    const res = await fetch("/api/chat/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, allow }),
    });
    if (!res.ok) patchLast(() => ({ error: "That confirmation is no longer pending." }));
  }

  async function openInClaudeCode() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = input.trim() || (lastUser?.role === "user" ? lastUser.text : "");
    const res = await fetch("/api/chat/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = (await res.json()) as { ok: boolean; command: string };
    if (data.ok) {
      setTerminalNote("Opened Terminal.");
    } else {
      await navigator.clipboard.writeText(data.command).catch(() => {});
      setTerminalNote(`Couldn't open Terminal. Command copied to clipboard: ${data.command}`);
    }
  }

  return (
    <div className="flex h-[calc(100svh-8rem)] flex-col gap-3">
      {health && !health.ok && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {health.message}
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask about your captured activity. Read-only tools run automatically; anything that writes or deletes asks
            you first.
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {m.text}
            </div>
          ) : (
            <div key={i} className="max-w-[90%] space-y-2 text-sm">
              {m.parts.map((p, j) =>
                p.kind === "text" ? (
                  <p key={j} className="whitespace-pre-wrap">
                    {p.text}
                  </p>
                ) : (
                  <ToolCallCard key={p.id} tool={p} onAnswer={answer} />
                )
              )}
              {busy && i === messages.length - 1 && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Working" />
              )}
              {m.error && <p className="text-destructive">{m.error}</p>}
            </div>
          )
        )}
        <div ref={bottom} />
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="What did I work on last Tuesday?"
          rows={3}
          autoFocus={Boolean(initialPrompt)}
          // Seeded prompts end in "Question: "; put the caret there.
          onFocus={(e) => {
            const end = e.currentTarget.value.length;
            e.currentTarget.setSelectionRange(end, end);
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={openInClaudeCode}>
            <SquareTerminal />
            Open in Claude Code
          </Button>
          {terminalNote && <span className="truncate text-xs text-muted-foreground">{terminalNote}</span>}
          {busy ? (
            <Button type="button" variant="outline" size="sm" onClick={() => abort.current?.abort()}>
              <Square />
              Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!input.trim()}>
              <Send />
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
