"use client";

import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { displayToolName } from "@/lib/chat/protocol";

export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  permission?: { requestId: string; state: "pending" | "allowed" | "denied" };
}

function status(tool: ToolPart): { label: string; variant: "secondary" | "destructive" | "outline" } {
  if (tool.permission?.state === "pending") return { label: "needs approval", variant: "destructive" };
  if (tool.permission?.state === "denied") return { label: "declined", variant: "outline" };
  if (tool.isError) return { label: "error", variant: "destructive" };
  if (tool.result === undefined) return { label: "running", variant: "secondary" };
  return { label: tool.permission ? "approved" : "done", variant: "secondary" };
}

/** One tool call: which tool, with which arguments, and what came back. */
export function ToolCallCard({ tool, onAnswer }: { tool: ToolPart; onAnswer: (requestId: string, allow: boolean) => void }) {
  const s = status(tool);
  const pending = tool.permission?.state === "pending";
  const [open, setOpen] = useState(false);

  return (
    <div className={`rounded-md border ${pending ? "border-destructive/50" : "border-border"} bg-card text-xs`}>
      {/* Forced open while awaiting approval so the arguments are in view. */}
      <Collapsible open={open || pending} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
          <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
          <Wrench className="size-3.5 text-muted-foreground" />
          <code className="font-mono font-medium">{displayToolName(tool.name)}</code>
          <span className="truncate font-mono text-muted-foreground">{JSON.stringify(tool.input)}</span>
          <Badge variant={s.variant} className="ml-auto">
            {s.label}
          </Badge>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 border-t border-border px-3 py-2">
          <div>
            <div className="mb-1 text-muted-foreground">Arguments</div>
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">{JSON.stringify(tool.input, null, 2)}</pre>
          </div>
          {tool.result !== undefined && (
            <div>
              <div className="mb-1 text-muted-foreground">Result</div>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">{tool.result}</pre>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
      {pending && tool.permission && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="flex-1">This tool changes your data. Run it?</span>
          <Button size="sm" variant="outline" onClick={() => onAnswer(tool.permission!.requestId, false)}>
            Deny
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onAnswer(tool.permission!.requestId, true)}>
            Allow
          </Button>
        </div>
      )}
    </div>
  );
}
