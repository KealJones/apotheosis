import { execSync } from 'child_process';
import * as path from 'path';
import { getDb } from '../db.js';

export interface CodeTimeArgs {
  repo_path: string;
  since: string;
}

export interface CodeTimeResult {
  repo: string;
  repo_name: string;
  since: string;
  git_author: string;
  commits: string[];
  commit_count: number;
  sample_count: number;
  estimated_active_seconds: number;
  estimated_active_hours: number;
}

function getGitAuthor(repoPath: string): string {
  try {
    return execSync('git config user.email', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    try {
      return execSync('git config user.name', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      return 'unknown';
    }
  }
}

export function getCodeTime(args: CodeTimeArgs): CodeTimeResult {
  const db = getDb();
  const repoName = path.basename(args.repo_path);
  const sinceMs = Math.floor(new Date(args.since).getTime() / 1000);

  // Get git author dynamically
  const author = getGitAuthor(args.repo_path);

  // Get commits
  let commits: string[] = [];
  try {
    const output = execSync(
      `git log --author="${author}" --since="${args.since}" --oneline`,
      { cwd: args.repo_path, encoding: 'utf8', timeout: 15000 }
    );
    commits = output.trim().split('\n').filter(Boolean);
  } catch {
    commits = [];
  }

  // Estimate active time from sample count — each sample represents ~15 seconds of screen time
  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM samples WHERE taken_at >= ? AND window_title LIKE ?`
  ).get(sinceMs, `%${repoName}%`) as { count: number };

  const estimated_active_seconds = countRow.count * 15;

  return {
    repo: args.repo_path,
    repo_name: repoName,
    since: args.since,
    git_author: author,
    commits,
    commit_count: commits.length,
    sample_count: countRow.count,
    estimated_active_seconds,
    estimated_active_hours: Math.round((estimated_active_seconds / 3600) * 10) / 10,
  };
}
