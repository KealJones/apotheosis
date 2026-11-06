import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Leak check for the public repo: no tracked file may contain a term from the user's local
 * `private-terms.txt` (employer, org, internal hosts, coworker names). The list lives in the
 * data dir and is never committed, so this skips on machines that don't have one.
 *
 * Reads the real data dir on purpose: other tests point DATA_DIR at a temp dir, but this one
 * never calls setupTestDb, so DATA_DIR here is whatever the user set (or unset).
 */
const termsFile = path.join(
  process.env.DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'apotheosis'),
  'private-terms.txt'
);
const repoRoot = path.resolve(__dirname, '../../..');

function loadTerms(): string[] {
  if (!fs.existsSync(termsFile)) return [];
  return fs
    .readFileSync(termsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const terms = loadTerms();

describe.skipIf(terms.length === 0)('private data leak check', () => {
  it('no tracked file contains a term from private-terms.txt', () => {
    const args = ['grep', '-n', '-I', '-i', '-F', ...terms.flatMap((t) => ['-e', t])];
    let hits = '';
    try {
      hits = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    } catch (err) {
      // git grep exits 1 when nothing matches; anything else is a real failure.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    // Report file:line only, not the matched text, so the failure output doesn't leak either.
    const locations = hits.split('\n').filter(Boolean).map((l) => l.split(':').slice(0, 2).join(':'));
    expect(locations, `private terms found in tracked files (see ${termsFile})`).toEqual([]);
  });
});
