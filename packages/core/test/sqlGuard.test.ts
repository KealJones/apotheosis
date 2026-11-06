import { describe, it, expect } from 'vitest';
import { validateSelectOnlyQuery } from '../src/sqlGuard.js';

describe('validateSelectOnlyQuery', () => {
  it('accepts a plain SELECT', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples');
    expect(result.ok).toBe(true);
  });

  it('accepts WITH ... SELECT', () => {
    const result = validateSelectOnlyQuery(
      'WITH recent AS (SELECT * FROM samples) SELECT * FROM recent'
    );
    expect(result.ok).toBe(true);
  });

  it('rejects DELETE with a clear message, not a silent no-op', () => {
    const result = validateSelectOnlyQuery('DELETE FROM samples');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/only.*select/i);
    }
  });

  it('rejects UPDATE/INSERT/DROP appearing anywhere in the query', () => {
    for (const sql of [
      'UPDATE samples SET v = 1',
      "INSERT INTO samples (v) VALUES ('x')",
      'DROP TABLE samples',
      'WITH x AS (SELECT 1) INSERT INTO samples SELECT * FROM x',
    ]) {
      const result = validateSelectOnlyQuery(sql);
      expect(result.ok, `expected "${sql}" to be rejected`).toBe(false);
    }
  });

  it('rejects a multi-statement injection attempt', () => {
    // Rejected either as "multiple statements" or as "comments not allowed"
    // (the trailing "--") — both are correct rejections; what matters is it
    // never partially executes the DROP TABLE.
    const result = validateSelectOnlyQuery('SELECT 1; DROP TABLE samples;--');
    expect(result.ok).toBe(false);
  });

  it('rejects a multi-statement injection attempt with no comment involved', () => {
    const result = validateSelectOnlyQuery('SELECT 1; DROP TABLE samples');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/single|statement/i);
    }
  });

  it('rejects a semicolon hidden mid-string as a real statement boundary only when outside quotes', () => {
    // A semicolon INSIDE a string literal is not a statement separator.
    const ok = validateSelectOnlyQuery("SELECT * FROM samples WHERE v = 'a;b'");
    expect(ok.ok).toBe(true);

    // But a real second statement must be rejected.
    const bad = validateSelectOnlyQuery("SELECT * FROM samples; DELETE FROM samples");
    expect(bad.ok).toBe(false);
  });

  it('rejects SQL comments outright', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples -- ; DELETE FROM samples');
    expect(result.ok).toBe(false);
  });

  it('allows a trailing single semicolon', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples;');
    expect(result.ok).toBe(true);
  });

  it('appends LIMIT 1000 when the query has none', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toMatch(/LIMIT 1000$/);
      expect(result.appliedLimit).toBe(1000);
    }
  });

  it('caps a user-specified LIMIT larger than the max down to the max', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples LIMIT 50000');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toContain('LIMIT 1000');
      expect(result.sql).not.toContain('50000');
      expect(result.appliedLimit).toBe(1000);
    }
  });

  it('respects a user-specified LIMIT smaller than the max, unchanged', () => {
    const result = validateSelectOnlyQuery('SELECT * FROM samples LIMIT 10');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toContain('LIMIT 10');
      expect(result.appliedLimit).toBe(10);
    }
  });

  it('rejects empty input', () => {
    expect(validateSelectOnlyQuery('').ok).toBe(false);
    expect(validateSelectOnlyQuery('   ').ok).toBe(false);
  });

  it('rejects PRAGMA and ATTACH tricks', () => {
    expect(validateSelectOnlyQuery('PRAGMA table_info(samples)').ok).toBe(false);
    expect(validateSelectOnlyQuery("ATTACH DATABASE '/tmp/evil.db' AS evil").ok).toBe(false);
  });
});
