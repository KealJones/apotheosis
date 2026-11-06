"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartEmpty } from "@/components/analytics/chart-empty";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";

export interface TrendPoint {
  x: string;
  y: number;
}

interface TrendLineChartProps {
  data: TrendPoint[];
  unit: string;
  valueLabel: string;
  xLabel: string;
  emptyLabel: string;
}

/**
 * Single-series trend-over-time line chart (choosing-a-form.md: "trend over
 * time" -> line, sequential/1 hue). One series needs no legend box — the
 * card title above it already names what's plotted.
 */
// Above this many points, per-point dots turn into visual noise (a wide date
// range over hourly buckets can have hundreds) — drop them and let the line
// + crosshair tooltip carry it, per marks-and-anatomy.md's "thin marks" rule.
const DOT_THRESHOLD = 60;

export function TrendLineChart({ data, unit, valueLabel, xLabel, emptyLabel }: TrendLineChartProps) {
  if (data.length === 0) return <ChartEmpty label={emptyLabel} />;
  const showDots = data.length <= DOT_THRESHOLD;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 20 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="x"
          stroke="var(--muted-foreground)"
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          label={{ value: xLabel, position: "insideBottom", offset: -10, fill: "var(--muted-foreground)", fontSize: 11 }}
        />
        <YAxis
          stroke="var(--muted-foreground)"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          label={{ value: unit, angle: -90, position: "insideLeft", fill: "var(--muted-foreground)", fontSize: 11 }}
        />
        <Tooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
          content={(props) => <ChartTooltip {...props} unit={unit} />}
        />
        <Line
          type="monotone"
          dataKey="y"
          name={valueLabel}
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={showDots ? { r: 4, fill: "var(--chart-1)", stroke: "var(--card)", strokeWidth: 2 } : false}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
