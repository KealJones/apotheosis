"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartEmpty } from "@/components/analytics/chart-empty";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";

export interface RankedBarRow {
  label: string;
  value: number;
  /** True for a fold-in bucket like "Other" / "Unassigned" — rendered muted, never a real series hue. */
  muted?: boolean;
}

interface RankedBarChartProps {
  data: RankedBarRow[];
  unit: string;
  valueLabel: string;
  emptyLabel: string;
  height?: number;
}

/**
 * Horizontal magnitude-ranking bar chart — the dataviz skill's default form
 * for "compare magnitude, low -> high" (choosing-a-form.md). One hue
 * (categorical slot 1); a muted gray for the fold-in "Other"/"Unassigned"
 * bucket keeps that bucket from reading as just another series.
 */
export function RankedBarChart({ data, unit, valueLabel, emptyLabel, height }: RankedBarChartProps) {
  if (data.length === 0) return <ChartEmpty label={emptyLabel} />;

  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="0" />
        <XAxis
          type="number"
          stroke="var(--muted-foreground)"
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          label={{ value: unit, position: "insideBottom", offset: -4, fill: "var(--muted-foreground)", fontSize: 11 }}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={140}
          stroke="var(--muted-foreground)"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "var(--accent)" }}
          content={(props) => <ChartTooltip {...props} unit={unit} />}
        />
        <Bar dataKey="value" name={valueLabel} radius={[0, 4, 4, 0]} barSize={20} isAnimationActive={false}>
          {data.map((row, i) => (
            <Cell key={i} fill={row.muted ? "var(--chart-muted)" : "var(--chart-1)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
