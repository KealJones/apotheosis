"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartEmpty } from "@/components/analytics/chart-empty";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";

export interface ActiveHoursPoint {
  day: string;
  hours: number;
  isWeekend: boolean;
}

const LEGEND_ENTRIES = [
  { label: "Weekday", color: "var(--chart-1)" },
  { label: "Weekend", color: "var(--chart-2)" },
];

/**
 * Active hours per day, one bar per day, colored by weekday vs weekend —
 * two categorical series (slots 1 and 2), so a legend is mandatory even
 * though each day only ever shows one of the two colors. Recharts' <Legend>
 * reads its entries from the chart's own series/dataKeys, which doesn't fit
 * a single dataKey colored per-Cell, so this renders a plain legend row
 * instead (same pattern as the totals row on the time-breakdown chart).
 */
export function WeekdaySplitChart({ data }: { data: ActiveHoursPoint[] }) {
  if (data.length === 0) return <ChartEmpty label="No activity in this range." />;

  return (
    <div className="flex flex-col gap-2">
      <ResponsiveContainer width="100%" height={220}>
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
          <Bar dataKey="hours" name="Active hours" radius={[4, 4, 0, 0]} barSize={20} isAnimationActive={false}>
            {data.map((row, i) => (
              <Cell key={i} fill={row.isWeekend ? "var(--chart-2)" : "var(--chart-1)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-4 text-xs text-muted-foreground">
        {LEGEND_ENTRIES.map((entry) => (
          <span key={entry.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
