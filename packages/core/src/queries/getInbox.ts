import { getDb } from '../db.js';
import { scanAndGroupMentions, CompactGroupedMention } from './mentions.js';
import { getPendingReviews, PrItem } from '../integrations/github.js';
import { getRankedCommitments } from './rankedCommitments.js';

export interface GetInboxArgs {
  mentions_since?: string;
}

export interface InboxResult {
  mentions: CompactGroupedMention[];
  pending_reviews: PrItem[];
  open_commitments: {
    id: number;
    source: string;
    source_ref: string;
    title: string;
    detail: string | null;
    detected_at: string;
    score: number;
  }[];
  summary: {
    total_mentions: number;
    total_prs: number;
    total_commitments: number;
  };
}

export function getInbox(args: GetInboxArgs): InboxResult {
  const db = getDb();

  // Default mentions_since to 48 hours ago
  const since48h = args.mentions_since
    ? Math.floor(new Date(args.mentions_since).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 48 * 3600;

  // 1. Compact mention groups
  const fullGroups = scanAndGroupMentions(db, since48h);
  const mentions: CompactGroupedMention[] = fullGroups.map(g => ({
    app_name: g.app_name,
    window_title: g.window_title,
    url: g.url,
    mention_count: g.mention_count,
    first_seen: g.mentions[0].when,
    last_seen: g.mentions[g.mentions.length - 1].when,
  }));

  // 2. Pending PR reviews
  let pending_reviews: PrItem[] = [];
  try {
    pending_reviews = getPendingReviews();
  } catch {
    // gh not available — return empty
  }

  // 3. Open commitments, ranked the same way todo_list ranks them (top items only;
  // todo_list has the full list and the low-confidence "maybe" tray).
  const { ranked, total_open } = getRankedCommitments();

  return {
    mentions,
    pending_reviews,
    open_commitments: ranked.map(f => ({
      id: f.id,
      source: f.source,
      source_ref: f.source_ref,
      title: f.title,
      detail: f.detail,
      detected_at: new Date(f.detected_at * 1000).toISOString(),
      score: f.score,
    })),
    summary: {
      total_mentions: mentions.reduce((sum, m) => sum + m.mention_count, 0),
      total_prs: pending_reviews.length,
      total_commitments: total_open,
    },
  };
}
