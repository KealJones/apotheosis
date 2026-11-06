/**
 * Test setup helper: injects the fixture database into the db.ts singleton
 * so all tool handlers use the in-memory test data.
 */
import { _setDbForTesting, _resetDb } from '../../src/db.js';
import { createTestDb } from '../fixtures/seed-test-db.js';
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testDb: DatabaseSync;
let testDataDir: string | null = null;
let originalDataDir: string | undefined;
let originalClaudeDir: string | undefined;

/**
 * Call in beforeAll() — creates the seeded in-memory DB and injects it.
 * Also creates a temp data dir with user-config.json for mention pattern tests.
 * Returns the DB instance for direct queries in assertions.
 */
export function setupTestDb(): DatabaseSync {
  testDb = createTestDb();
  _setDbForTesting(testDb);

  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apotheosis-test-'));
  fs.writeFileSync(path.join(testDataDir, 'user-config.json'), JSON.stringify({
    github_username: 'testuser',
    display_name: 'Test User',
    mention_patterns: ['@testuser', 'Test User'],
  }));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = testDataDir;
  // Keep standup_draft away from the real ~/.claude transcripts.
  originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = testDataDir;

  return testDb;
}

/**
 * Call in afterAll() — closes the DB and resets the singleton.
 */
export function teardownTestDb(): void {
  if (testDb) {
    testDb.close();
  }
  _resetDb();

  if (testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = null;
  }
  if (originalDataDir !== undefined) {
    process.env.DATA_DIR = originalDataDir;
  } else {
    delete process.env.DATA_DIR;
  }
  if (originalClaudeDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}
