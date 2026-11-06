"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartEmpty } from "@/components/analytics/chart-empty";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";

export interface TimeBreakdownPoint {
  day: string;
  codingHours: number;
  meetingHours: number;
  slackHours: number;
  otherHours: number;
}

const SERIES = [
  { key: "codingHours", name: "Coding", color: "var(--chart-1)" },
  { key: "meetingHours", name: "Meetings", color: "var(--chart-2)" },
  { key: "slackHours", name: "Slack", color: "var(--chart-3)" },
  { key: "otherHours", name: "Other", color: "var(--chart-4)" },
] as const;

/**
 * Coding vs meeting vs Slack vs other time, stacked per day — part-to-whole
 * (choosing-a-form.md), categorical color, 4 series. At 4 series the ladder
 * in choosing-a-form.md makes direct labels mandatory; a per-segment inline
 * label doesn't fit in a stacked bar this thin, so the totals row below the
 * chart is the direct-label substitute (every value stays reachable without
 * hovering, per interaction.md).
 */
export function TimeBreakdownChart({ data }: { data: TimeBreakdownPoint[] }) {
  if (data.length === 0) return <ChartEmpty label="No coding, meeting, or Slack activity in this range." />;

  const totals = SERIES.map((s) => ({
    ...s,
    total: data.reduce((sum, row) => sum + (row[s.key] as number), 0),
  }));

  return (
    <div className="flex flex-col gap-2">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 20 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="day"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            label={{ value: "Date", position: "insideBottom", offset: -10, fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            label={{ value: "Hours", angle: -90, position: "insideLeft", fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <Tooltip cursor={{ fill: "var(--accent)" }} content={(props) => <ChartTooltip {...props} unit="hours" />} />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
          {SERIES.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.name}
              stackId="breakdown"
              fill={s.color}
              radius={0}
              barSize={24}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {totals.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.name}: <span className="font-medium text-foreground">{s.total.toFixed(1)}h</span>
          </span>
        ))}
      </div>
    </div>
  );
}
