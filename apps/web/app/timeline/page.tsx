import { getTimelineSessions, listProjects } from "@/lib/data";
import { resolveDateRange } from "@/lib/date-range";
import { PageShell } from "@/components/page-shell";
import { SessionItem } from "@/components/timeline/session-item";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export default async function TimelinePage({ searchParams }: PageProps<"/timeline">) {
  const params = await searchParams;
  const { since, until } = resolveDateRange(params);

  const { sessions, total_samples } = getTimelineSessions({ since, until });
  const { projects } = listProjects();

  return (
    <PageShell title="Timeline">
      <div className="flex flex-col gap-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>
              {sessions.length} session{sessions.length === 1 ? "" : "s"} &middot; {total_samples} sample
              {total_samples === 1 ? "" : "s"}
            </CardDescription>
            <CardTitle className="text-sm font-medium">
              {new Date(since).toLocaleString()} &ndash; {new Date(until).toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>

        {sessions.length === 0 ? (
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-center">
            <p className="text-sm text-muted-foreground">No activity captured in this range.</p>
          </CardContent>
        ) : (
          <ScrollArea className="h-[calc(100vh-14rem)]">
            <div className="flex flex-col gap-2 pr-3">
              {sessions.map((session) => (
                <SessionItem key={session.sample_ids[0]} session={session} projects={projects} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </PageShell>
  );
}
