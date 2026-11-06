import {
  getActiveHoursByDay,
  getAiLeverage,
  getContextSwitchRate,
  getMeetingLoad,
  getTimeByApp,
  getTimeByProject,
  getTimeBreakdown,
} from "@/lib/data";
import { resolveDateRange } from "@/lib/date-range";
import { PageShell } from "@/components/page-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RankedBarChart } from "@/components/analytics/ranked-bar-chart";
import { TrendLineChart } from "@/components/analytics/trend-line-chart";
import { WeekdaySplitChart } from "@/components/analytics/weekday-split-chart";
import { TimeBreakdownChart } from "@/components/analytics/time-breakdown-chart";
import { MeetingLoadChart } from "@/components/analytics/meeting-load-chart";

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const params = await searchParams;
  const { since, until } = resolveDateRange(params);
  const range = { since, until };

  // Every chart below is a server component fetching straight from
  // @apotheosis/core (all synchronous node:sqlite queries — no client-side
  // SQL, no client-side fetching for the raw numbers). Each Recharts chart
  // is a small client wrapper that only renders the numbers computed here.
  const activeHours = getActiveHoursByDay(range);
  const timeByApp = getTimeByApp(range);
  const timeByProject = getTimeByProject(range);
  const contextSwitchRate = getContextSwitchRate(range);
  const timeBreakdown = getTimeBreakdown(range);
  const aiLeverage = getAiLeverage(range);
  const meetingLoad = getMeetingLoad(range);

  const appRows = [
    ...timeByApp.apps.map((a) => ({ label: a.app, value: a.hours })),
    ...(timeByApp.otherHours > 0 ? [{ label: "Other", value: timeByApp.otherHours, muted: true }] : []),
  ];

  const projectRows = [
    ...timeByProject.projects.map((p) => ({ label: p.project, value: p.hours })),
    ...(timeByProject.unassignedHours > 0
      ? [{ label: "Unassigned", value: timeByProject.unassignedHours, muted: true }]
      : []),
  ];

  const contextSwitchPoints = contextSwitchRate.hours.map((h) => ({ x: h.hour.slice(5), y: h.switches }));
  const aiCallsPerDay = aiLeverage.perDay.map((d) => ({ x: d.day, y: d.calls }));
  const topToolRows = aiLeverage.topTools.map((t) => ({ label: t.name, value: t.calls }));
  const skillRows = aiLeverage.skillsInvoked.map((s) => ({ label: s.name, value: s.calls }));

  return (
    <PageShell title="Analytics">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Active hours per day</CardTitle>
            <CardDescription>Estimated from capture samples · weekday vs weekend</CardDescription>
          </CardHeader>
          <CardContent>
            <WeekdaySplitChart data={activeHours.days} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Time by app</CardTitle>
            <CardDescription>Estimated active hours, by application</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBarChart
              data={appRows}
              unit="Hours"
              valueLabel="Hours"
              emptyLabel="No samples captured in this range."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Time by project</CardTitle>
            <CardDescription>
              Matched by project name/slug in window titles and file paths — see &ldquo;Unassigned&rdquo; for
              samples that didn&apos;t match a known project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBarChart
              data={projectRows}
              unit="Hours"
              valueLabel="Hours"
              emptyLabel="No project-matched activity in this range."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Context-switch rate</CardTitle>
            <CardDescription>App switches per hour — a focus proxy; lower is steadier</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendLineChart
              data={contextSwitchPoints}
              unit="Switches"
              valueLabel="App switches"
              xLabel="Hour"
              emptyLabel="No context-switch events in this range."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI tool calls per day</CardTitle>
            <CardDescription>MCP tool + skill invocations logged to tool_usage</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendLineChart
              data={aiCallsPerDay}
              unit="Calls"
              valueLabel="Calls"
              xLabel="Date"
              emptyLabel="No tool_usage activity in this range."
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Coding vs meeting vs Slack time</CardTitle>
            <CardDescription>Estimated hours per day, by activity category</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeBreakdownChart data={timeBreakdown.days} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top AI tools</CardTitle>
            <CardDescription>Most-called MCP tools in this range</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBarChart
              data={topToolRows}
              unit="Calls"
              valueLabel="Calls"
              emptyLabel="No tool calls in this range."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Skills invoked</CardTitle>
            <CardDescription>Most-invoked skills in this range</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBarChart
              data={skillRows}
              unit="Calls"
              valueLabel="Calls"
              emptyLabel="No skill invocations in this range."
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Meeting load</CardTitle>
            <CardDescription>Hours in meetings per week, with count and average length</CardDescription>
          </CardHeader>
          <CardContent>
            <MeetingLoadChart data={meetingLoad.weeks} />
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
