"use client";

import type { TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

interface ChartTooltipProps extends TooltipContentProps<ValueType, NameType> {
  unit?: string;
}

/**
 * Shared tooltip for every analytics chart — per the dataviz skill's
 * interaction rules: value leads (bold, high contrast), series name follows
 * (secondary ink), never colored text (identity comes from the swatch, not
 * the label color).
 */
export function ChartTooltip({ active, payload, label, unit }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {label ? <div className="mb-1 font-medium text-popover-foreground">{label}</div> : null}
      <div className="flex flex-col gap-1">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="font-semibold text-popover-foreground">
              {typeof entry.value === "number" ? entry.value.toLocaleString() : entry.value}
              {unit ? ` ${unit}` : ""}
            </span>
            <span className="text-muted-foreground">{entry.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
