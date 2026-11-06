"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const PRESETS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

function toDate(iso: string | null): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Date-range picker backed by the `?since=&until=` URL search params, so any
 * page using PageShell has a linkable/shareable range. Absent params mean
 * "last 24 hours" — see lib/date-range.ts for the shared default.
 */
export function DateRangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sinceParam = searchParams.get("since");
  const untilParam = searchParams.get("until");

  const range: DateRange | undefined = sinceParam || untilParam
    ? { from: toDate(sinceParam), to: toDate(untilParam) }
    : undefined;

  function applyRange(next: DateRange | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (next?.from) {
      params.set("since", next.from.toISOString());
    } else {
      params.delete("since");
    }
    if (next?.to) {
      params.set("until", next.to.toISOString());
    } else {
      params.delete("until");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const applyPreset = (days: number) => {
    const until = new Date();
    const from = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
    applyRange({ from, to: until });
  };

  const label =
    range?.from && range?.to
      ? `${range.from.toLocaleDateString()} – ${range.to.toLocaleDateString()}`
      : "Last 24 hours";

  return (
    <Popover>
      <PopoverTrigger
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <CalendarIcon />
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="end">
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset.days)}
                className={buttonVariants({ variant: "ghost", size: "xs" })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={range}
            defaultMonth={range?.from}
            onSelect={applyRange}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
