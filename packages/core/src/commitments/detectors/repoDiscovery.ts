import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ReadonlyDb } from '../types.js';

export interface LocalRepo {
  /** Absolute path to the repo's working tree root (the directory containing `.git`). */
  root: string;
  /** "owner/repo" parsed from the `origin` remote, if it points at github.com. */
  nwo: string | null;
}

/**
 * Repos to scan for the github_unaddressed/github_stale/github_ci_failing/git_local
 * detectors, derived from *where you've actually been working* rather than the whole
 * filesystem: distinct `document_path`s (files with focus/edits recorded by the capture
 * daemon) seen in `samples` and `context_events` since `since`, walked up to their nearest
 * `.git` root and deduped. A repo you haven't touched recently drops out on its own — no
 * separate cleanup needed.
 */
export function discoverLocalRepos(db: ReadonlyDb, since: number): LocalRepo[] {
  const paths = recentDocumentPaths(db, since);
  const roots = new Set<string>();
  for (const p of paths) {
    const root = findGitRoot(p);
    if (root) roots.add(root);
  }
  return [...roots].map((root) => ({ root, nwo: getRemoteNwo(root) }));
}

function recentDocumentPaths(db: ReadonlyDb, since: number): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT document_path FROM (
      SELECT document_path FROM samples WHERE document_path IS NOT NULL AND taken_at >= ?
      UNION
      SELECT document_path FROM context_events WHERE document_path IS NOT NULL AND taken_at >= ?
    )
  `).all(since, since) as { document_path: string }[];
  return rows.map((r) => r.document_path).filter((p): p is string => !!p);
}

function findGitRoot(filePath: string): string | null {
  let dir: string;
  try {
    dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  } catch {
    // File no longer exists (renamed/deleted since capture) — still worth checking its
    // parent directory for a repo root.
    dir = path.dirname(filePath);
  }
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function getRemoteNwo(root: string): string | null {
  try {
    const url = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Local, no-network git plumbing shared by the git_local detector. */
export function git(root: string, args: string): string {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
}

export function tryGit(root: string, args: string): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}
