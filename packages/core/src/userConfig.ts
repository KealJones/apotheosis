import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './db.js';

/** `user-config.json` in the data dir, written by `/init`. Every field is optional. */
export interface UserConfig {
  github_username?: string;
  /** Your Slack display name, e.g. "Jane Doe". Slack senders carry pronouns after it. */
  display_name?: string;
  /** Literal strings that mean "someone is talking about/to you", e.g. "@jane". */
  mention_patterns?: string[];
  /**
   * Case-insensitive regex fragments for pages that count as work (your company's domains,
   * GitHub org, internal tools), matched against window titles and URLs, e.g.
   * ["github\\.com/my-org", "\\.mycompany\\.com"].
   */
  work_patterns?: string[];
  keep_meeting_audio?: boolean;
}

/** Re-read on every call (it's tiny) so edits apply without a restart. Missing/corrupt → {}. */
export function readUserConfig(): UserConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'user-config.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
