import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';
import { addManualCommitment } from '../../src/queries/addManualCommitment.js';
import { getTodoList } from '../../src/queries/todoList.js';

let db: ReturnType<typeof setupTestDb>;

beforeAll(() => { db = setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  db.exec('DELETE FROM commitments');
});

const NOW = 1_700_000_000;

describe('addManualCommitment', () => {
  it('writes a full-confidence, open, manual-source row', () => {
    const c = addManualCommitment({ title: 'Renew passport', detail: 'Expires next month', now: NOW });

    expect(c.source).toBe('manual');
    expect(c.title).toBe('Renew passport');
    expect(c.detail).toBe('Expires next month');
    expect(c.confidence).toBe(1);
    expect(c.status).toBe('open');
    expect(c.detected_at).toBe(NOW);
    expect(c.source_ref.startsWith('manual:')).toBe(true);
  });

  it('trims the title and rejects an empty one', () => {
    const c = addManualCommitment({ title: '  Buy milk  ', now: NOW });
    expect(c.title).toBe('Buy milk');
    expect(() => addManualCommitment({ title: '   ', now: NOW })).toThrow(/title is required/);
  });

  it('mints a distinct source_ref per call, even for identical titles at the same instant (no UNIQUE collision)', () => {
    const a = addManualCommitment({ title: 'Same title', now: NOW });
    const b = addManualCommitment({ title: 'Same title', now: NOW });
    expect(a.id).not.toBe(b.id);
    expect(a.source_ref).not.toBe(b.source_ref);

    const rows = db.prepare(`SELECT COUNT(*) as n FROM commitments WHERE source = 'manual'`).get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('always lands in the main ranked list, never the maybe tray', () => {
    addManualCommitment({ title: 'A manual todo', now: NOW });
    const result = getTodoList({ now: NOW, include_maybe: true });
    expect(result.todos).toHaveLength(1);
    expect(result.maybe).toEqual([]);
  });
});
