---
name: evidence
# prettier-ignore
description: Turn captured activity into performance-review evidence — a brag doc, promo packet, self-assessment, or peer-feedback prep. Mines standups, projects, AI usage, and Slack recognition over a date range and drafts a structured narrative.
---

0. **Log usage**: Call `log_usage` with `{ skill: "evidence" }` (include any args the user passed).

1. **Resolve the range and intent**:
   - Default range: the current half-year (H1 = Jan 1–Jun 30, H2 = Jul 1–Dec 31). The user can override: `/evidence H1 2026`, `/evidence since may`, `/evidence 2026-01-01..2026-07-24`, `/evidence last quarter`.
   - Note the intent if stated: mid-year review, year-end review, promo packet, brag doc, or peer-feedback prep. Default to a self-assessment narrative.

2. **Data pass** — call `evidence_report` with `{ since, until }` (ISO8601). It returns a compact payload:
   - `projects` + `links_by_kind` — tracked projects and how much linked evidence each has (scope/breadth).
   - `standups` — full logged standups in range. **This is your richest narrative source** — real dated accomplishments, PR numbers, people, meetings.
   - `ai_usage` — tool/skill call totals and top tools (quantifies AI leverage).
   - `ai_usage_wins` — **curated, quantified AI-impact entries** from the `log-ai-use` skill (`best` = the flagship win, `entries_in_range` = dated wins in the period). Lead the AI section with these — they are far stronger than raw call counts.
   - `ideas` — captured ideas/initiatives.
   - `evidence_sample_count` — screen samples explicitly tagged as evidence.
   - `slack_signals` — messages matching recognition/leadership keywords (praise, handoffs, thanks, shout-outs). **Verify each quote against the source before citing it** — these are OCR/capture excerpts.

3. **GitHub enrichment pass** (optional but recommended for engineering reviews):
   - Use the GitHub MCP server to quantify code contribution over the range: merged PRs authored (`author:<user> is:merged merged:<since>..<until>`), PRs reviewed (`reviewed-by:<user>`), and notable ADRs/docs. Get the username with `gh api user -q .login`.
   - Cross-reference with `projects` and `standups` so nothing real is under-counted (e.g. CI/reliability PRs, extra ADRs, cross-team reviews that don't show up as owned tickets).
   - If the GitHub MCP is unavailable, skip gracefully and note it.

4. **Draft the narrative**. Default to the company's mid/year review shape unless the user asks otherwise:
   ```
   **Overall** — one or two sentences framing the period.
   **Progress toward goals** — what shipped, grounded in standups + PRs.
   **Impact** — the standout work; quantify (timelines, scope, downstream effect).
   **Key behaviors & skills** — reliability, initiative, cross-team collaboration, mentorship.
   **Use of AI** — quantify with ai_usage; name concrete workflows and outcomes.
   **Priorities / next** — forward-looking, if relevant.
   ```
   Rules:
   - **Ground every claim in the data.** Prefer specific numbers (weeks, PR counts, hours saved, tool calls) over adjectives. Never fabricate — if the data doesn't support a claim, drop it.
   - **Surface under-counted work.** Cross-referencing standups against the formal goal list often reveals real contributions the review misses (extra ADRs, daily PR review, tooling migrations, infra fixes). Call these out.
   - **PR links** as `[repo#number](url)`. **Slack recognition** only if verified; attribute the speaker.
   - Distinguish shipped vs in-progress. Distinguish what you did from what the team did.

5. **Offer to persist**. Ask: "Save this to the growth archive? (yes/no)".
   - If yes and `~/Documents/Staff_Engineer_Growth_Archive/` exists, follow its README conventions: synthesized narratives → `artifacts/`, dated review/meeting notes → `discussion_logs/YYYY-MM-DD-session-NN.md`, raw inputs → `source_documents/`.
   - Otherwise save alongside the user's chosen location.

## Notes
- `evidence_report` is compact by design; if a specific window needs more detail, follow up with `summarize_window` (screen sessions), `usage_stats` (deeper AI breakdown), `slack_search` (verify a recognition quote), or `get_project` (a single project's linked evidence).
- Don't dump the raw `evidence_report` JSON at the user — it's context for writing, like `standup_draft` in `/standup`.
- Integrity: this is a real person's career record. No inflation, no invented metrics, no unverified quotes. Cite sources so claims are checkable.
