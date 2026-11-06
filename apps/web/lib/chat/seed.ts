// Builds the prefilled chat prompt for "Ask Claude about this page". Input is
// the page's path + query string (e.g. "/timeline?since=...&until=...").

/** Routes whose second path segment is an entity id, e.g. /meetings/42. */
const ENTITY_ROUTES: Record<string, string> = {
  meetings: "meeting",
  projects: "project",
  standups: "standup",
};

export function buildPageSeed(about: string): string {
  const url = new URL(about, "http://local");
  const [section, id] = url.pathname.split("/").filter(Boolean);
  const lines = [`I'm looking at the Apotheosis dashboard page \`${url.pathname}\`.`];

  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  lines.push(
    since || until
      ? `Date range: ${since ?? "(start)"} to ${until ?? "now"}.`
      : "Date range: the default (last 24 hours)."
  );

  if (section && id && ENTITY_ROUTES[section]) lines.push(`It shows ${ENTITY_ROUTES[section]} id ${id}.`);

  const extra = [...url.searchParams].filter(([k]) => k !== "since" && k !== "until");
  if (extra.length) lines.push(`Other page params: ${extra.map(([k, v]) => `${k}=${v}`).join(", ")}.`);

  lines.push("", "Question: ");
  return lines.join("\n");
}
