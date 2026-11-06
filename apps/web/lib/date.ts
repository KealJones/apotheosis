/**
 * Local (server-machine) calendar date as YYYY-MM-DD - matches the convention
 * `@apotheosis/core`'s `getStandupDraft()` defaults to when no `date` is passed, so a
 * standup generated here for "today" lines up with what the standup panel checks against.
 */
export function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
