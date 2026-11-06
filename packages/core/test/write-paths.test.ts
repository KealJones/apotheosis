import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/setup.js';
import { getDb } from '../src/db.js';
import { createProject } from '../src/queries/createProject.js';
import { logStandup } from '../src/queries/logStandup.js';
import { deleteMeeting } from '../src/queries/deleteMeeting.js';
import { listProjects } from '../src/queries/listProjects.js';
import { listStandups } from '../src/queries/listStandups.js';

describe('B4 write paths', () => {
  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('creates a project and verifies it exists via listProjects', () => {
    const result = createProject({
      slug: 'test-project',
      name: 'Test Project',
      description: 'A test project for B4',
    });

    expect('error' in result).toBe(false);
    expect((result as any).id).toBeGreaterThan(0);
    expect((result as any).name).toBe('Test Project');

    const projects = listProjects();
    const foundProject = projects.projects.find((p) => p.slug === 'test-project');
    expect(foundProject).toBeDefined();
    expect(foundProject?.name).toBe('Test Project');
  });

  it('logs a standup and verifies it exists via listStandups', () => {
    logStandup({
      date: '2026-09-23',
      yesterday: 'Worked on projects feature',
      today: 'Continue with meetings',
      blockers: 'None',
    });

    const result = listStandups({ limit: 50 });
    const foundStandup = result.standups.find((s) => s.date === '2026-09-23');
    expect(foundStandup).toBeDefined();
    expect(foundStandup?.today).toBe('Continue with meetings');
    expect(foundStandup?.blockers).toBe('None');
  });

  it('deletes a meeting (if one exists in test fixture)', () => {
    const db = getDb();
    const meeting = db.prepare('SELECT id FROM meetings LIMIT 1').get() as any;

    if (meeting) {
      const result = deleteMeeting({ meeting_id: meeting.id });
      expect(result.deleted).toBe(true);

      const verifyDeleted = db
        .prepare('SELECT id FROM meetings WHERE id = ?')
        .get(meeting.id);
      expect(verifyDeleted).toBeUndefined();
    }
  });
});
