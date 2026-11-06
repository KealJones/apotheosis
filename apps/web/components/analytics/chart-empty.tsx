/** Shared empty state for a chart with no rows in the selected range. */
export function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
