import { Suspense, type ReactNode } from "react";

import { AskClaudeButton } from "@/components/ask-claude-button";
import { DateRangePicker } from "@/components/date-range-picker";
import { buttonVariants } from "@/components/ui/button";

interface PageShellProps {
  title: string;
  children: ReactNode;
}

/**
 * Shared chrome for every dashboard route: a title, the URL-backed date
 * range picker, and the "Ask Claude about this page" entry point (B7). Individual
 * routes only need to supply their title and body content.
 *
 * DateRangePicker reads useSearchParams(), which opts a page out of static
 * rendering unless wrapped in Suspense — the fallback below is what a static
 * shell shows for the instant before the client component hydrates.
 */
export function PageShell({ title, children }: PageShellProps) {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        <div className="flex items-center gap-2">
          <Suspense
            fallback={
              <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                Last 24 hours
              </span>
            }
          >
            <DateRangePicker />
          </Suspense>
          <AskClaudeButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
