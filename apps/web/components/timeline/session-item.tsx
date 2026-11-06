"use client";

import { useState, useTransition } from "react";
import { ChevronDownIcon, ImageOffIcon } from "lucide-react";
import type { TimelineSession } from "@apotheosis/core";

import { deleteSampleAction, linkSampleToProjectAction } from "@/app/timeline/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

interface ProjectOption {
  slug: string;
  name: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SessionItem({
  session,
  projects,
}: {
  session: TimelineSession;
  projects: ProjectOption[];
}) {
  const [open, setOpen] = useState(false);
  const [projectSlug, setProjectSlug] = useState(projects[0]?.slug ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (removed) return null;

  function handleLink() {
    if (!projectSlug) return;
    startTransition(async () => {
      const result = await linkSampleToProjectAction(session.sample_ids, projectSlug);
      setMessage("error" in result ? result.error : `Linked ${result.linked} sample(s) to ${result.project_name}.`);
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSampleAction(session.sample_ids);
      if (result.refused.length > 0) {
        setMessage(`Refused: ${result.refused.length} sample(s) are tagged as evidence.`);
      } else {
        setRemoved(true);
      }
    });
  }

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatTime(session.start)} &ndash; {formatTime(session.end)}
            </span>
            <span className="truncate text-sm font-medium">
              {session.app_name ?? "Unknown app"}
            </span>
            {session.window_titles[0] && (
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                {session.window_titles[0]}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{session.duration_min}m</Badge>
            <Badge variant="secondary">{session.sample_count} samples</Badge>
            <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Separator />
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                {session.screenshot_exists && session.representative_sample_id != null ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served from our own route handler, not a static asset
                  <img
                    src={`/api/screenshot?id=${session.representative_sample_id}`}
                    alt={`Screenshot from ${session.app_name ?? "session"}`}
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-1 text-muted-foreground">
                    <ImageOffIcon className="size-5" />
                    <span className="text-xs">No screenshot</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 text-sm">
                {session.window_titles.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Window titles</p>
                    <ul className="flex flex-col gap-0.5">
                      {session.window_titles.slice(0, 5).map((title) => (
                        <li key={title} className="truncate">{title}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {session.urls && session.urls.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">URLs</p>
                    <ul className="flex flex-col gap-0.5">
                      {session.urls.slice(0, 5).map((url) => (
                        <li key={url} className="truncate">
                          <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {session.ocr_excerpt && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">OCR excerpt</p>
                    <p className="line-clamp-4 text-muted-foreground">{session.ocr_excerpt}</p>
                  </div>
                )}

                {session.events.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Events</p>
                    <ul className="flex flex-col gap-0.5">
                      {session.events.slice(0, 6).map((e) => (
                        <li key={e.id} className="truncate text-xs text-muted-foreground">
                          {formatTime(e.time)} &middot; {e.event_type}
                          {e.document_path ? ` — ${e.document_path}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              {projects.length > 0 && (
                <>
                  <select
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={projectSlug}
                    onChange={(e) => setProjectSlug(e.target.value)}
                    disabled={isPending}
                  >
                    {projects.map((p) => (
                      <option key={p.slug} value={p.slug}>{p.name}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" onClick={handleLink} disabled={isPending}>
                    Link to project (evidence)
                  </Button>
                </>
              )}
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={isPending}>
                Delete
              </Button>
              {message && <span className="text-xs text-muted-foreground">{message}</span>}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
