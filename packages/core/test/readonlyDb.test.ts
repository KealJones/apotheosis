/**
 * Verifies getReadOnlyDb()'s read-only enforcement is real, not just a label.
 * Per the B5 task's acceptance criteria: try a write against it and confirm
 * it throws, don't just trust the `readOnly` option name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getReadOnlyDb, _resetReadOnlyDb } from '../src/readonlyDb.js';

let testDataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-ro-test-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = testDataDir;

  // Seed a real file-backed DB at the path getDbPath()/getReadOnlyDb() expect.
  const seed = new DatabaseSync(path.join(testDataDir, 'apotheosis.db'));
  seed.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, v TEXT)');
  seed.prepare('INSERT INTO samples (v) VALUES (?), (?)').run('a', 'b');
  seed.close();
});

afterEach(() => {
  _resetReadOnlyDb();
  if (originalDataDir !== undefined) {
    process.env.DATA_DIR = originalDataDir;
  } else {
    delete process.env.DATA_DIR;
  }
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('getReadOnlyDb', () => {
  it('reads existing rows', () => {
    const db = getReadOnlyDb();
    const rows = db.prepare('SELECT * FROM samples ORDER BY id').all();
    expect(rows).toHaveLength(2);
  });

  it('throws on DELETE — read-only is enforced at the SQLite level, not just the API surface', () => {
    const db = getReadOnlyDb();
    expect(() => db.prepare('DELETE FROM samples').run()).toThrow(/readonly/i);
  });

  it('throws on INSERT', () => {
    const db = getReadOnlyDb();
    expect(() => db.prepare("INSERT INTO samples (v) VALUES ('c')").run()).toThrow(/readonly/i);
  });

  it('a rejected write leaves the underlying table unchanged', () => {
    const db = getReadOnlyDb();
    try {
      db.prepare('DELETE FROM samples').run();
    } catch {
      // expected
    }

    const verify = new DatabaseSync(path.join(testDataDir, 'apotheosis.db'), { readOnly: true });
    const count = verify.prepare('SELECT COUNT(*) as c FROM samples').get() as { c: number };
    expect(count.c).toBe(2);
    verify.close();
  });
});
