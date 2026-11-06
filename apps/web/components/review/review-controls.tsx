"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { exportPacketAction, scoreReviewAction, type ReviewParams } from "@/app/review/actions";
import { Button } from "@/components/ui/button";

interface LevelOption {
  id: string;
  code: string;
  title: string;
}

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

/** Current/target level pickers, backed by URL params so a review is linkable. */
export function LevelPickers({ levels, current, target }: { levels: LevelOption[]; current: string; target: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: "current" | "target", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  const picker = (key: "current" | "target", label: string, value: string) => (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select className={selectClass} value={value} onChange={(e) => set(key, e.target.value)} aria-label={`${label} level`}>
        {levels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.code} {l.title}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      {picker("current", "Current", current)}
      <span className="text-muted-foreground">&rarr;</span>
      {picker("target", "Target", target)}
    </div>
  );
}

export function ReviewActions({ params, unscored }: { params: ReviewParams; unscored: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function score(force: boolean) {
    setMessage(null);
    startTransition(async () => {
      const r = await scoreReviewAction(params, force);
      if (!r.success) setMessage(r.error);
      else if (r.llm_error) setMessage(r.llm_error);
      else if (r.unscored > 0) setMessage(`${r.unscored} criteria could not be scored; see each card.`);
      router.refresh();
    });
  }

  function exportPacket() {
    setMessage(null);
    startTransition(async () => {
      const r = await exportPacketAction(params);
      if (!r.success) {
        setMessage(r.error);
        return;
      }
      const blob = new Blob([r.markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `promo-packet-${params.current_level}-to-${params.target_level}.md`;
      a.click();
      URL.revokeObjectURL(url);
      const notes = [
        r.unscored > 0 ? `${r.unscored} criteria unscored` : null,
        r.violations > 0 ? `${r.violations} writing-rule flags (listed at the top of the file)` : null,
      ].filter(Boolean);
      if (notes.length) setMessage(`Exported with ${notes.join(", ")}.`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => score(false)} disabled={pending}>
        {pending ? "Working..." : unscored > 0 ? `Score ${unscored} unscored` : "Score"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => score(true)} disabled={pending}>
        Rescore all
      </Button>
      <Button size="sm" variant="outline" onClick={exportPacket} disabled={pending}>
        Export packet (.md)
      </Button>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </div>
  );
}
