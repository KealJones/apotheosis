import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { getDb } from '../../src/db.js';
import { summarizeMeeting } from '../../src/queries/summarizeMeeting.js';

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockOllama(): ReturnType<typeof vi.fn> {
  const validSummary = JSON.stringify({
    tldr: 'Design review covered accessibility work.',
    topics: ['accessibility', 'color palette'],
    decisions: ['"We focused on accessibility this time."'],
    action_items: [{ text: 'Follow up on palette contrast', owner: 'me' }],
    open_questions: [],
    my_contributions: ['Praised the new color palette'],
  });

  const fetchMock = vi.fn(async (url: string) => {
    if (url.toString().endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: [] }) };
    }
    if (url.toString().endsWith('/api/chat')) {
      return { ok: true, json: async () => ({ message: { content: validSummary } }) };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockOllamaUnreachable(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('summarize_meeting', () => {
  it('returns the cached summary without calling Ollama when one already exists', async () => {
    const fetchMock = mockOllama();

    // Meeting 1 in the fixture already has a summary (transcript_status completed).
    const result = await summarizeMeeting({ meeting_id: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
    expect(result.cached).toBe(true);
    expect(result.meeting_id).toBe(1);
  });

  it('returns a clear error (and caches nothing) when Ollama is unreachable', async () => {
    mockOllamaUnreachable();

    const before = getDb().prepare('SELECT summary FROM meetings WHERE id = ?').get(2) as { summary: string | null };
    expect(before.summary).toBeNull();

    const result = await summarizeMeeting({ meeting_id: 2 });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Ollama/);
      expect(result.error).toMatch(/not reachable/);
    }

    const after = getDb().prepare('SELECT summary, summary_model, summary_generated_at FROM meetings WHERE id = ?').get(2) as {
      summary: string | null; summary_model: string | null; summary_generated_at: number | null;
    };
    expect(after.summary).toBeNull();
    expect(after.summary_model).toBeNull();
    expect(after.summary_generated_at).toBeNull();
  });

  it('returns an error for an unknown meeting id', async () => {
    mockOllama();
    const result = await summarizeMeeting({ meeting_id: 999999 });
    expect('error' in result).toBe(true);
  });

  it('generates and caches a summary when Ollama is available', async () => {
    const fetchMock = mockOllama();

    const result = await summarizeMeeting({ meeting_id: 2 });

    expect(fetchMock).toHaveBeenCalled();
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
    expect(result.cached).toBe(false);
    expect(result.summary.tldr).toContain('accessibility');
    expect(result.summary.action_items).toEqual([{ text: 'Follow up on palette contrast', owner: 'me' }]);
    expect(result.model).toBeTruthy();

    const row = getDb().prepare('SELECT summary, summary_model, summary_generated_at, action_items FROM meetings WHERE id = ?').get(2) as {
      summary: string; summary_model: string; summary_generated_at: number; action_items: string;
    };
    expect(row.summary).toBeTruthy();
    expect(row.summary_model).toBeTruthy();
    expect(row.summary_generated_at).toBeTypeOf('number');
    expect(JSON.parse(row.action_items)).toEqual([{ text: 'Follow up on palette contrast', owner: 'me' }]);
  });

  it('does NOT call Ollama again on a subsequent call without force', async () => {
    const fetchMock = mockOllama();

    const result = await summarizeMeeting({ meeting_id: 2 });

    expect(fetchMock).not.toHaveBeenCalled();
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
    expect(result.cached).toBe(true);
  });

  it('regenerates via Ollama when force is true, even though a cached summary exists', async () => {
    const fetchMock = mockOllama();

    const result = await summarizeMeeting({ meeting_id: 2, force: true });

    expect(fetchMock).toHaveBeenCalled();
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
    expect(result.cached).toBe(false);
  });
});
