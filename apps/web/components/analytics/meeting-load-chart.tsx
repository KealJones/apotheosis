"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartEmpty } from "@/components/analytics/chart-empty";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";

export interface MeetingLoadWeek {
  week: string;
  hours: number;
  count: number;
  avgMinutes: number;
}

/**
 * Meeting hours per week. Count and average length are a second measure on
 * a different scale — rather than a second y-axis (never a dual-axis chart,
 * see choosing-a-form.md / anti-patterns.md), they run as a plain table
 * under the chart so every number stays in one place, at one scale.
 */
export function MeetingLoadChart({ data }: { data: MeetingLoadWeek[] }) {
  if (data.length === 0) return <ChartEmpty label="No completed meetings in this range." />;

  return (
    <div className="flex flex-col gap-3">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 20 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="week"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            label={{ value: "ISO week", position: "insideBottom", offset: -10, fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            label={{ value: "Hours", angle: -90, position: "insideLeft", fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <Tooltip cursor={{ fill: "var(--accent)" }} content={(props) => <ChartTooltip {...props} unit="hours" />} />
          <Bar dataKey="hours" name="Meeting hours" radius={[4, 4, 0, 0]} barSize={28} fill="var(--chart-1)" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 font-normal">Week</th>
            <th className="py-1 font-normal">Meetings</th>
            <th className="py-1 font-normal">Avg length</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.week} className="border-b border-border/50 last:border-0">
              <td className="py-1">{row.week}</td>
              <td className="py-1">{row.count}</td>
              <td className="py-1">{row.avgMinutes} min</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
