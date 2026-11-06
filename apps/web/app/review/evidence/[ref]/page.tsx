import Link from "next/link";
import { notFound } from "next/navigation";

import { getEvidenceItem } from "@/lib/data";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The record behind a review citation, re-read from the database (or the AI
 * usage log) by ref. 404s if the record no longer exists, so a citation that
 * renders here is a citation that is real.
 */
export default async function EvidencePage({ params }: PageProps<"/review/evidence/[ref]">) {
  const { ref } = await params;
  const item = getEvidenceItem(decodeURIComponent(ref));
  if (!item) notFound();

  const native = item.source === "meetings" ? `/meetings/${item.key}` : null;

  return (
    <PageShell title="Evidence">
      <Card size="sm">
        <CardHeader>
          <CardDescription>
            {item.ref} &middot; {item.store === "file" ? `AI usage log file ${item.key}` : `${item.store} row ${item.key}`}{" "}
            &middot; {item.date.slice(0, 10)}
          </CardDescription>
          <CardTitle data-evidence-ref={item.ref}>{item.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap text-sm">{item.text}</p>
          <div className="flex gap-3 text-sm">
            {native && (
              <Link href={native} className="underline underline-offset-4">
                Open meeting
              </Link>
            )}
            {item.external_url && (
              <a href={item.external_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Open original
              </a>
            )}
            <Link href="/review" className="text-muted-foreground underline-offset-4 hover:underline">
              Back to review
            </Link>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
