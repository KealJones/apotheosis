import { DbBrowser } from "@/components/db-browser";
import { PageShell } from "@/components/page-shell";

export default function DbPage() {
  return (
    <PageShell title="Database">
      <DbBrowser />
    </PageShell>
  );
}
