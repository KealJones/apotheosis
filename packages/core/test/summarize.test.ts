import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/setup.js';
import {
  cleanUrl, cleanTitle, isFsPath,
  groupIntoBlocks, groupIntoSessions,
} from '../src/summarize.js';
import { DAY_START_ISO, DAY_END_ISO, TEST_STANDUP_DATE } from './fixtures/seed-test-db.js';
import { getDb } from '../src/db.js';
import type { SampleRow } from '../src/summarize.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

// ── cleanUrl ────────────────────────────────────────────────────────────────

describe('cleanUrl', () => {
  it('strips query strings and fragments', () => {
    expect(cleanUrl('https://acme.atlassian.net/browse/WID-4582?param=1#section'))
      .toBe('https://acme.atlassian.net/browse/WID-4582');
  });

  it('preserves ?q= for Google search URLs', () => {
    const cleaned = cleanUrl('https://google.com/search?q=weekend+hiking+trails&ie=UTF-8&oq=weekend');
    expect(cleaned).toContain('?q=');
    expect(cleaned).not.toContain('ie=');
  });

  it('preserves ?q= for Bing and DuckDuckGo', () => {
    expect(cleanUrl('https://www.bing.com/search?q=test&ref=abc')).toContain('?q=');
    expect(cleanUrl('https://duckduckgo.com/?q=test&t=h_')).toContain('?q=');
  });

  it('returns chrome:// URLs unchanged', () => {
    expect(cleanUrl('chrome://newtab/')).toBe('chrome://newtab/');
  });

  it('returns unparseable strings unchanged', () => {
    expect(cleanUrl('not a url at all')).toBe('not a url at all');
  });

  it('collapses signed URLs to host+path', () => {
    const signed = 'https://production-content.workramp.com/uploads/file.pdf?Expires=123&Signature=abc&Key-Pair-Id=XYZ';
    expect(cleanUrl(signed)).toBe('https://production-content.workramp.com/uploads/file.pdf');
  });
});

// ── cleanTitle ──────────────────────────────────────────────────────────────

describe('cleanTitle', () => {
  it('strips " - Google Chrome" suffix', () => {
    expect(cleanTitle('[WID-4582] JIRA board - Google Chrome', 'Google Chrome'))
      .toBe('[WID-4582] JIRA board');
  });

  it('strips " - Google Chrome - Jane (Person 1)" suffix', () => {
    expect(cleanTitle('Panda New Tab - Google Chrome - Jane (Person 1)', 'Google Chrome'))
      .toBe('Panda New Tab');
  });

  it('strips " — AppName" with em-dash', () => {
    expect(cleanTitle('figmaTestUtils.ts — widgets', 'Code'))
      .toBe('figmaTestUtils.ts — widgets');
  });

  it('strips " - Acme Corp - Slack" suffix', () => {
    expect(cleanTitle('Alex Chen (DM) - Acme Corp - Slack', 'Slack'))
      .toBe('Alex Chen (DM) - Acme Corp');
  });

  it('returns original if stripping would empty the string', () => {
    expect(cleanTitle('Google Chrome', 'Google Chrome')).toBe('Google Chrome');
  });

  it('returns original if appName is null', () => {
    expect(cleanTitle('Some Title - Chrome', null)).toBe('Some Title - Chrome');
  });
});

// ── isFsPath ────────────────────────────────────────────────────────────────

describe('isFsPath', () => {
  it('returns true for local file paths', () => {
    expect(isFsPath('/Users/testuser/projects/file.ts')).toBe(true);
  });

  it('returns false for HTTP URLs', () => {
    expect(isFsPath('https://acme.atlassian.net/browse/WID-4582')).toBe(false);
    expect(isFsPath('http://example.com/page')).toBe(false);
  });

  it('returns true for chrome:// URLs', () => {
    expect(isFsPath('chrome://newtab/')).toBe(true);
  });
});

// ── Session-level cleaning (integration) ────────────────────────────────────

describe('buildSession cleaning', () => {
  function getYesterdaySessions() {
    const db = getDb();
    const todayDate = new Date('2026-05-19T00:00:00');
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStart = Math.floor(yesterdayDate.getTime() / 1000);
    const yesterdayEnd = Math.floor(todayDate.getTime() / 1000) - 1;

    const samples = db.prepare(`
      SELECT id, taken_at, app_bundle, app_name, window_title, url,
             screenshot_path, ocr_text, active_seconds, is_evidence,
             document_path, selected_text, focused_element
      FROM samples
      WHERE taken_at >= ? AND taken_at <= ?
      ORDER BY taken_at ASC
    `).all(yesterdayStart, yesterdayEnd) as SampleRow[];

    const blocks = groupIntoBlocks(samples);
    return groupIntoSessions(blocks);
  }

  it('strips Chrome suffix from session window_titles', () => {
    const sessions = getYesterdaySessions();
    const chromeSessions = sessions.filter(s => s.app_bundle === 'com.google.Chrome');
    for (const s of chromeSessions) {
      for (const t of s.window_titles) {
        expect(t).not.toMatch(/ - Google Chrome/);
      }
    }
  });

  it('strips query strings from session urls', () => {
    const sessions = getYesterdaySessions();
    const chromeSessions = sessions.filter(s => s.urls && s.urls.length > 0);
    for (const s of chromeSessions) {
      for (const u of s.urls!) {
        if (u.includes('google.com/search')) {
          expect(u).toMatch(/\?q=/);
          expect(u).not.toMatch(/&ie=/);
        } else if (!u.startsWith('chrome://')) {
          expect(u).not.toContain('?');
        }
      }
    }
  });

  it('excludes HTTP document_paths', () => {
    const sessions = getYesterdaySessions();
    for (const s of sessions) {
      if (s.document_paths) {
        for (const p of s.document_paths) {
          expect(p).not.toMatch(/^https?:\/\//);
        }
      }
    }
  });

  it('omits empty optional arrays', () => {
    const sessions = getYesterdaySessions();
    for (const s of sessions) {
      if ('urls' in s) expect(s.urls!.length).toBeGreaterThan(0);
      if ('top_words' in s) expect(s.top_words!.length).toBeGreaterThan(0);
      if ('document_paths' in s) expect(s.document_paths!.length).toBeGreaterThan(0);
      if ('selected_texts' in s) expect(s.selected_texts!.length).toBeGreaterThan(0);
      if ('focused_elements' in s) expect(s.focused_elements!.length).toBeGreaterThan(0);
    }
  });

  it('does not extract false-positive JIRA tickets like UTF-8', () => {
    const sessions = getYesterdaySessions();
    const allTickets = sessions.flatMap(s => s.metadata.jira_tickets);
    expect(allTickets).not.toContain('UTF-8');
    expect(allTickets).not.toContain('ISO-8601');
    expect(allTickets).toContain('WID-4582');
  });
});
