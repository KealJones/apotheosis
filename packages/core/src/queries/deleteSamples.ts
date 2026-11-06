import * as fs from 'fs';
import { getDb, transaction } from '../db.js';

export interface DeleteSamplesArgs {
  ids: number[];
}

interface SampleRow {
  id: number;
  is_evidence: number;
  screenshot_path: string;
}

export interface DeleteSamplesResult {
  deleted: number[];
  refused: number[];
  errors: string[];
  summary: string;
}

export function deleteSamples(args: DeleteSamplesArgs): DeleteSamplesResult {
  const db = getDb();

  const deleted: number[] = [];
  const refused: number[] = [];
  const errors: string[] = [];

  transaction(db, () => {
    for (const id of args.ids) {
      const row = db.prepare(
        'SELECT id, is_evidence, screenshot_path FROM samples WHERE id = ?'
      ).get(id) as SampleRow | undefined;

      if (!row) {
        errors.push(`Sample ${id} not found.`);
        continue;
      }

      if (row.is_evidence === 1) {
        refused.push(id);
        continue;
      }

      // Delete the screenshot file
      try {
        if (fs.existsSync(row.screenshot_path)) {
          fs.unlinkSync(row.screenshot_path);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Could not delete file for sample ${id}: ${msg}`);
        // Still delete the DB row even if file removal fails
      }

      db.prepare('DELETE FROM samples WHERE id = ?').run(id);
      deleted.push(id);
    }
  });

  return {
    deleted,
    refused,
    errors,
    summary: `Deleted ${deleted.length}, refused ${refused.length} (evidence), errors ${errors.length}.`,
  };
}
