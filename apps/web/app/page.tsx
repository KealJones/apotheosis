import {
  getRecentActivity,
  getTodoList,
  getMeetings,
  getLatestStandup,
  getCurrentProjectGuess,
} from "@/lib/data";
import { resolveDateRange } from "@/lib/date-range";
import { todayLocalDate } from "@/lib/date";
import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { StandupPanel } from "@/components/standup/standup-panel";
import { TodoPanel } from "@/components/commitments/todo-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function TodayPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const { since, until } = resolveDateRange(params);

  // Pulled directly from the real Apotheosis SQLite DB via @apotheosis/core —
  // not a hardcoded placeholder. See lib/data.ts for the server-only guard.
  // getRecentActivity caps at 200 rows, so treat an exact 200 as "200+".
  const { samples } = getRecentActivity({ since, until });
  const sampleCountLabel = samples.length === 200 ? "200+" : String(samples.length);

  const appCounts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.app_name ?? "Unknown";
    appCounts.set(key, (appCounts.get(key) ?? 0) + 1);
  }
  const topApps = [...appCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Active hours: distinct clock hours (in the selected range) that have at least one sample.
  const activeHours = new Set(samples.map((s) => new Date(s.time).getHours())).size;

  const { todos, total_open } = getTodoList();
  const { meetings } = getMeetings({ since, until });
  const latestStandup = getLatestStandup();
  const projectGuess = getCurrentProjectGuess();

  // Today's To-Do (C6/C8) reads the ranked commitments table, which the scheduled
  // detector runner (packages/core/scripts/run-detectors.mjs) keeps fresh on its own
  // interval -- this page never blocks on `gh` or Ollama itself.
  const today = todayLocalDate();
  const standupInitial =
    latestStandup && latestStandup.date === today
      ? { yesterday: latestStandup.yesterday, today: latestStandup.today, blockers: latestStandup.blockers }
      : null;

  return (
    <PageShell title="Today">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Samples captured</CardDescription>
            <CardTitle className="text-3xl">{sampleCountLabel}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {new Date(since).toLocaleString()} &ndash; {new Date(until).toLocaleString()}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Active hours</CardDescription>
            <CardTitle className="text-3xl">{activeHours}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Distinct clock hours with at least one sample in range.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Current project guess</CardDescription>
            <CardTitle className="text-base">
              {projectGuess == null
                ? "No recent activity"
                : projectGuess.matched
                  ? projectGuess.project_name
                  : (projectGuess.app_name ?? "Unknown")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {projectGuess == null
              ? "Nothing captured in the last 45 minutes."
              : projectGuess.matched
                ? `Matched via ${projectGuess.basis} mentioned in recent activity.`
                : `Best guess from the last active window${projectGuess.window_title ? `: "${projectGuess.window_title}"` : "."} Not linked to a tracked project.`}
          </CardContent>
        </Card>

        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader>
            <CardTitle>Top apps</CardTitle>
            <CardDescription>By sample count in range</CardDescription>
          </CardHeader>
          <CardContent>
            {topApps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No samples captured in this range.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {topApps.map(([app, count]) => (
                  <li key={app} className="flex items-center justify-between text-sm">
                    <span>{app}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Meetings</CardTitle>
            <CardDescription>In the selected range</CardDescription>
          </CardHeader>
          <CardContent>
            {meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No meetings detected. Meeting recording isn&rsquo;t fully wired up yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {meetings.map((m) => (
                  <li key={m.id} className="flex items-center justify-between text-sm">
                    <span className="truncate">{m.title ?? m.platform ?? "Untitled meeting"}</span>
                    <Badge variant="outline">{m.transcript_status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Standup</CardTitle>
            <CardDescription>{today}</CardDescription>
          </CardHeader>
          <CardContent>
            <StandupPanel today={today} initial={standupInitial} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Today&rsquo;s To-Do</CardTitle>
            <CardDescription>Ranked open commitments -- what you said you&rsquo;d do and haven&rsquo;t yet</CardDescription>
          </CardHeader>
          <CardContent>
            <TodoPanel todos={todos} totalOpen={total_open} />
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
