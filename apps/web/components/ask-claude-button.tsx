"use client";

import { usePathname, useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "Ask Claude about this page": opens /chat with the current route and query
 * string (date range, any entity params) as `?about=`, which the chat turns
 * into a prefilled prompt. Nothing is sent until the user hits Send.
 *
 * The URL is read at click time from window.location rather than
 * useSearchParams(), so PageShell doesn't need an extra Suspense boundary.
 */
export function AskClaudeButton() {
  const router = useRouter();
  const pathname = usePathname();
  if (pathname === "/chat") return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const about = window.location.pathname + window.location.search;
        router.push(`/chat?about=${encodeURIComponent(about)}`);
      }}
    >
      <Sparkles />
      Ask Claude about this page
    </Button>
  );
}
