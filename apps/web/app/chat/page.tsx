import { ChatPanel } from "@/components/chat/chat-panel";
import { PageShell } from "@/components/page-shell";
import { buildPageSeed } from "@/lib/chat/seed";

export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const { about } = await searchParams;
  const initialPrompt = typeof about === "string" && about.startsWith("/") ? buildPageSeed(about) : "";

  return (
    <PageShell title="Chat">
      <ChatPanel initialPrompt={initialPrompt} />
    </PageShell>
  );
}
