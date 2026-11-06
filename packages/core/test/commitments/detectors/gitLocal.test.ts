import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb, _resetDb, type Db } from '../../../src/db.js';
import { runDetectors, type Commitment } from '../../../src/commitments/index.js';
import { gitLocal } from '../../../src/commitments/detectors/gitLocal.js';

// git_local is the one detector with zero `gh` calls, so this test exercises real git
// plumbing against a throwaway repo + bare "remote" instead of mocking anything.
const DAY = 86_400;

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

function initRepoWithRemote(root: string, bareRemote: string): void {
  fs.mkdirSync(root, { recursive: true });
  sh('git init -q -b main .', root);
  sh('git config user.email test@example.com', root);
  sh('git config user.name "Test User"', root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'hello\n');
  sh('git add .', root);
  sh('git commit -q -m init', root);
  sh(`git remote add origin ${bareRemote}`, root);
  sh('git push -q -u origin main', root);
  sh('git remote set-head origin main', root);
}

function recordDocumentPath(db: Db, filePath: string, takenAt: number): void {
  db.prepare('INSERT INTO samples (taken_at, screenshot_path, document_path) VALUES (?, ?, ?)').run(
    takenAt, '/dev/null', filePath,
  );
}

function rows(db: Db): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE source = 'git_local' ORDER BY id").all() as Commitment[];
}

let dataDir: string;
let originalDataDir: string | undefined;
let db: Db;
let bareRemote: string;
let repoRoot: string;
const realNow = Math.floor(Date.now() / 1000);

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-gitlocal-data-'));
  process.env.DATA_DIR = dataDir;
  _resetDb();
  db = getDb();

  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-gitlocal-bare-'));
  execSync(`git init -q --bare ${bareRemote}`);
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-gitlocal-repo-'));
  initRepoWithRemote(repoRoot, bareRemote);
  recordDocumentPath(db, path.join(repoRoot, 'file.txt'), realNow);
});

afterEach(() => {
  _resetDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
  else delete process.env.DATA_DIR;
});

describe('git_local', () => {
  it('does not flag a fully-pushed, in-sync repo', async () => {
    const report = await runDetectors({ detectors: [gitLocal], now: realNow });
    expect(report.detectors[0].detected).toBe(0);
  });

  it('flags a branch with unpushed commits', async () => {
    fs.writeFileSync(path.join(repoRoot, 'file2.txt'), 'world\n');
    sh('git add .', repoRoot);
    sh('git commit -q -m wip', repoRoot);

    const report = await runDetectors({ detectors: [gitLocal], now: realNow });
    expect(report.detectors[0]).toMatchObject({ detected: 1, inserted: 1 });
    expect(rows(db)[0]).toMatchObject({ status: 'open' });
    expect(rows(db)[0].title).toContain('Unpushed commits');
    expect(rows(db)[0].detail).toContain('1 commit(s)');
  });

  it('resolves done once the unpushed commit is pushed', async () => {
    fs.writeFileSync(path.join(repoRoot, 'file2.txt'), 'world\n');
    sh('git add .', repoRoot);
    sh('git commit -q -m wip', repoRoot);
    await runDetectors({ detectors: [gitLocal], now: realNow });
    expect(rows(db)[0].status).toBe('open');

    sh('git push -q origin main', repoRoot);
    const report = await runDetectors({ detectors: [gitLocal], now: realNow + 60 });

    expect(report.detectors[0].resolved).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: 'done', resolution_note: 'No longer unpushed and no longer looks like it needs a PR' });
  });

  it('flags a pushed branch that has diverged from main and gone quiet, as a lower-confidence signal', async () => {
    sh('git checkout -q -b feature-x', repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'feature.txt'), 'feature\n');
    sh('git add .', repoRoot);
    sh('git commit -q -m feature', repoRoot);
    sh('git push -q -u origin feature-x', repoRoot);
    recordDocumentPath(db, path.join(repoRoot, 'feature.txt'), realNow);

    // "quiet" is relative to ctx.now, so push now-in-real-time then evaluate far enough in
    // the future that the commit looks stale, without needing to fake git timestamps.
    const farFuture = realNow + 10 * DAY;
    const report = await runDetectors({ detectors: [gitLocal], now: farFuture });

    const featureRow = rows(db).find((r) => r.title.includes('feature-x'));
    expect(featureRow).toBeDefined();
    expect(featureRow!.title).toContain('may need a PR');
    expect(featureRow!.confidence).toBeLessThan(0.5);
  });

  it('resolves done when the branch is deleted (e.g. merged and cleaned up)', async () => {
    sh('git checkout -q -b feature-y', repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'feature-y.txt'), 'feature\n');
    sh('git add .', repoRoot);
    sh('git commit -q -m feature-y', repoRoot);
    sh('git push -q -u origin feature-y', repoRoot);
    recordDocumentPath(db, path.join(repoRoot, 'feature-y.txt'), realNow);

    const farFuture = realNow + 10 * DAY;
    await runDetectors({ detectors: [gitLocal], now: farFuture });
    expect(rows(db).some((r) => r.title.includes('feature-y'))).toBe(true);

    sh('git checkout -q main', repoRoot);
    sh('git branch -D feature-y', repoRoot);
    const report = await runDetectors({ detectors: [gitLocal], now: farFuture + 60 });

    expect(report.detectors[0].resolved).toBeGreaterThanOrEqual(1);
    const row = rows(db).find((r) => r.title.includes('feature-y'))!;
    expect(row).toMatchObject({ status: 'done', resolution_note: 'Branch no longer exists locally (merged/deleted)' });
  });
});
