/**
 * Thin re-export of @apotheosis/core's test DB setup, so apps/mcp's thin
 * tool-wrapper smoke tests run against the same seeded fixture database as
 * the core query tests, without duplicating the fixture or setup logic.
 */
export { setupTestDb, teardownTestDb } from '../../../../packages/core/test/helpers/setup.js';
