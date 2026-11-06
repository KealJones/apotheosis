import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { logStandup } from '../../../src/queries/logStandup.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { standupCarryover } from '../../../src/commitments/detectors/standupCarryover.js';

let dataDir: string;
let originalDataDir: string | undefined;
let db: Db;

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-standup-carryover-'));
  process.env.DATA_DIR = dataDir;
  _resetDb();
  db = getDb();
});

afterEach(() => {
  _resetDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

function rows(): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'standup' ORDER BY id").all() as Commitment[];
}

const NOW = Math.floor(Date.parse('2026-09-22T00:00:00Z') / 1000);

describe('standup_carryover', () => {
  it('flags a today item that never shows up in a later yesterday section', async () => {
    logStandup({ date: '2026-09-15', yesterday: '- Reviewed onboarding docs', today: '- Ship IP-500 config validator', blockers: 'None' });
    logStandup({ date: '2026-09-16', yesterday: '- Unrelated work on something else', today: '- More unrelated work', blockers: 'None' });

    const report = await runDetectors({ detectors: [standupCarryover], now: NOW });

    // Both today items start as open commitments: the 9/15 one because its text never
    // shows up in 9/16's yesterday, and the 9/16 one because there's no later standup yet
    // to confirm it — every today/blockers item starts open until a future standup's
    // yesterday says otherwise.
    expect(report.detectors[0].detected).toBe(2);
    const shipItem = rows().find((c) => c.title.includes('IP-500 config validator'))!;
    expect(shipItem).toMatchObject({ status: 'open' });
    expect(shipItem.detail).toContain('2026-09-15');
  });

  it('does not flag an item that is fuzzy-matched in a later yesterday section', async () => {
    logStandup({ date: '2026-09-15', yesterday: 'None', today: '- Ship IP-500 config validator', blockers: 'None' });
    logStandup({ date: '2026-09-16', yesterday: '- Shipped the IP-500 config validator', today: '- Something new', blockers: 'None' });

    const report = await runDetectors({ detectors: [standupCarryover], now: NOW });

    // The 9/15 item is resolved by 9/16's yesterday; only "Something new" (9/16's own
    // today, not yet confirmed by any later standup) remains.
    expect(report.detectors[0].detected).toBe(1);
    expect(rows().some((c) => c.title.includes('IP-500'))).toBe(false);
  });

  it('links the carryover commitment back to the originating standup date via source_ref/detail', async () => {
    logStandup({ date: '2026-09-10', yesterday: 'None', today: '- Follow up with Morgan on design review', blockers: 'None' });
    logStandup({ date: '2026-09-11', yesterday: 'None', today: 'None', blockers: 'None' });

    await runDetectors({ detectors: [standupCarryover], now: NOW });

    const commitment = rows()[0];
    expect(commitment.source_ref).toMatch(/^standup:\d+#today#0$/);
    // The origin standup is independently queryable from the source_ref, not just baked into text.
    const [, standupIdStr] = commitment.source_ref.match(/^standup:(\d+)#/)!;
    const standup = db.prepare('SELECT date FROM standups WHERE id = ?').get(Number(standupIdStr)) as { date: string };
    expect(standup.date).toBe('2026-09-10');
    expect(commitment.detail).toContain('2026-09-10');
  });

  it('advances last_activity_at while the item keeps recurring unfinished, rather than freezing at first detection', async () => {
    logStandup({ date: '2026-09-10', yesterday: 'None', today: '- Ship IP-777 rate limiter', blockers: 'None' });
    logStandup({ date: '2026-09-11', yesterday: 'None', today: '- Ship IP-777 rate limiter', blockers: 'None' });
    logStandup({ date: '2026-09-12', yesterday: 'None', today: 'None', blockers: 'None' });

    await runDetectors({ detectors: [standupCarryover], now: NOW });

    const commitment = rows().find((c) => c.title.includes('IP-777'))!;
    expect(commitment.last_activity_at).toBe(Math.floor(Date.parse('2026-09-11T00:00:00Z') / 1000));
  });

  it('resolves done once a later standup reports the item finished in "yesterday"', async () => {
    logStandup({ date: '2026-09-10', yesterday: 'None', today: '- Ship IP-777 rate limiter', blockers: 'None' });
    await runDetectors({ detectors: [standupCarryover], now: NOW });
    expect(rows()[0].status).toBe('open');

    logStandup({ date: '2026-09-11', yesterday: '- Shipped IP-777 rate limiter', today: 'None', blockers: 'None' });
    const report = await runDetectors({ detectors: [standupCarryover], now: NOW });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'done' });
    expect(rows()[0].resolution_note).toContain('IP-777');
  });

  it('treats a blockers item the same as a today item', async () => {
    logStandup({ date: '2026-09-10', yesterday: 'None', today: 'None', blockers: '- Waiting on IP-900 approval from Jordan' });
    logStandup({ date: '2026-09-11', yesterday: 'None', today: 'None', blockers: 'None' });

    const report = await runDetectors({ detectors: [standupCarryover], now: NOW });

    expect(report.detectors[0].detected).toBe(1);
    expect(rows()[0].source_ref).toContain('#blockers#');
  });
});
