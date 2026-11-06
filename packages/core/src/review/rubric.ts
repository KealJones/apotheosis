/**
 * Loads promo-packet.yaml and the leveling ladder it points at via
 * `ladder_ref`, validated with zod. Every inconsistency throws: a rubric that
 * quietly defaults something is a rubric that can score against the wrong bar.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getDataDir } from '../db.js';
import { EVIDENCE_SOURCES, isEvidenceSource, type EvidenceSource } from './evidence.js';

const LevelSchema = z.object({ id: z.string(), code: z.string(), title: z.string() });

const CriterionSchema = z.object({
  id: z.string(),
  title: z.string(),
  parent: z.string().optional(),
  prompt: z.string().optional(),
  evidence_sources: z.array(z.string()),
  // null is legitimate (the source sheet leaves some cells empty); missing is not.
  expectations: z.record(z.string(), z.string().nullable()),
});

const LadderSchema = z.object({
  version: z.number(),
  ladder: z.object({ id: z.string(), title: z.string() }),
  levels: z.array(LevelSchema).min(1),
  criteria: z.array(CriterionSchema).min(1),
});

const SectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['metadata', 'narrative', 'assessment', 'appendix']),
  word_limit: z.number().int().positive().optional(),
  guidance: z.string().optional(),
  fields: z.array(z.string()).optional(),
  criteria_ref: z.literal('all').optional(),
  count: z.tuple([z.number(), z.number()]).optional(),
  groups: z.array(z.string()).optional(),
  min_providers: z.record(z.string(), z.number()).optional(),
});

const WritingRuleSchema = z.object({
  id: z.string(),
  rule: z.string(),
  banned: z.array(z.string()).optional(),
});

const ValueSchema = z.object({ id: z.string(), title: z.string(), text: z.string() });

const PacketSchema = z.object({
  version: z.number(),
  ladder_ref: z.string(),
  defaults: z.object({ current_level: z.string(), target_level: z.string() }),
  sections: z.array(SectionSchema).min(1),
  rules: z.object({
    eligibility: z.object({ sustained_behavior_months: z.number().positive() }).passthrough().optional(),
    writing: z.array(WritingRuleSchema),
  }).passthrough(),
  values: z.array(ValueSchema),
  principles: z.array(ValueSchema),
}).passthrough();

export type Level = z.infer<typeof LevelSchema>;
export type PacketSection = z.infer<typeof SectionSchema>;
export type WritingRule = z.infer<typeof WritingRuleSchema>;

export interface Criterion {
  id: string;
  title: string;
  parent?: string;
  prompt?: string;
  evidence_sources: EvidenceSource[];
  /** Keyed by level id; null where the ladder has no expectation for that level. */
  expectations: Record<string, string | null>;
}

export interface Rubric {
  /** Content hash of both files. Any edit to either invalidates cached scores. */
  config_version: string;
  packet_version: number;
  ladder_version: number;
  ladder: { id: string; title: string };
  levels: Level[];
  criteria: Criterion[];
  defaults: { current_level: string; target_level: string };
  sections: PacketSection[];
  writing_rules: WritingRule[];
  /** rules.eligibility.sustained_behavior_months: how long cited evidence must span for "met". */
  sustained_behavior_months: number | null;
  values: z.infer<typeof ValueSchema>[];
  principles: z.infer<typeof ValueSchema>[];
}

const PACKET_FILE = 'promo-packet.yaml';

/**
 * Find the config dir: APOTHEOSIS_CONFIG_DIR, else `<data dir>/config` (your own,
 * never committed), else the nearest repo `config/` (the generic example)
 * walking up from the cwd, then from this module.
 */
export function findConfigDir(): string {
  if (process.env.APOTHEOSIS_CONFIG_DIR) return process.env.APOTHEOSIS_CONFIG_DIR;
  const userDir = path.join(getDataDir(), 'config');
  if (fs.existsSync(path.join(userDir, PACKET_FILE))) return userDir;
  const starts = [process.cwd()];
  try {
    starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundled without a file URL; cwd is still tried
  }
  for (const start of starts) {
    let dir = start;
    for (;;) {
      const candidate = path.join(dir, 'config', PACKET_FILE);
      if (fs.existsSync(candidate)) return path.dirname(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find config/${PACKET_FILE} above ${starts.join(' or ')}. Set APOTHEOSIS_CONFIG_DIR.`
  );
}

function parseFile<T>(file: string, schema: z.ZodType<T>): { data: T; raw: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read rubric file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = schema.safeParse(parseYaml(raw));
  if (!result.success) {
    throw new Error(`Invalid rubric file ${file}:\n${z.prettifyError(result.error)}`);
  }
  return { data: result.data, raw };
}

/** Load and cross-validate the packet config and its ladder. Throws on any inconsistency. */
export function loadRubric(configDir: string = findConfigDir()): Rubric {
  const packetPath = path.join(configDir, PACKET_FILE);
  const packet = parseFile(packetPath, PacketSchema);
  const ladderPath = path.resolve(path.dirname(packetPath), packet.data.ladder_ref);
  const ladder = parseFile(ladderPath, LadderSchema);

  const levelIds = ladder.data.levels.map((l) => l.id);
  const levelSet = new Set(levelIds);
  if (levelSet.size !== levelIds.length) throw new Error(`Duplicate level ids in ${ladderPath}`);

  const errors: string[] = [];
  const seen = new Set<string>();
  const criteria: Criterion[] = ladder.data.criteria.map((c) => {
    if (seen.has(c.id)) errors.push(`duplicate criterion id "${c.id}"`);
    seen.add(c.id);
    for (const s of c.evidence_sources) {
      if (!isEvidenceSource(s)) {
        errors.push(
          `criterion "${c.id}" names evidence source "${s}", which the evidence layer does not produce ` +
            `(known: ${EVIDENCE_SOURCES.join(', ')})`
        );
      }
    }
    for (const lv of Object.keys(c.expectations)) {
      if (!levelSet.has(lv)) errors.push(`criterion "${c.id}" has an expectation for unknown level "${lv}"`);
    }
    for (const lv of levelIds) {
      if (!(lv in c.expectations)) {
        errors.push(`criterion "${c.id}" is missing level "${lv}" (use null for a legitimately empty cell)`);
      }
    }
    return { ...c, evidence_sources: c.evidence_sources.filter(isEvidenceSource) };
  });

  for (const [k, lv] of Object.entries(packet.data.defaults)) {
    if (!levelSet.has(lv)) errors.push(`defaults.${k} is "${lv}", not a level in ${ladderPath}`);
  }
  if (errors.length) {
    throw new Error(`Rubric config is inconsistent:\n- ${errors.join('\n- ')}`);
  }

  return {
    config_version: createHash('sha256').update(packet.raw).update('\u0000').update(ladder.raw).digest('hex').slice(0, 16),
    packet_version: packet.data.version,
    ladder_version: ladder.data.version,
    ladder: ladder.data.ladder,
    levels: ladder.data.levels,
    criteria,
    defaults: packet.data.defaults,
    sections: packet.data.sections,
    writing_rules: packet.data.rules.writing,
    sustained_behavior_months: packet.data.rules.eligibility?.sustained_behavior_months ?? null,
    values: packet.data.values,
    principles: packet.data.principles,
  };
}

/** Look up a level by id. Throws on an unknown id; never falls back to a default. */
export function getLevel(rubric: Rubric, id: string): Level {
  const level = rubric.levels.find((l) => l.id === id);
  if (!level) {
    throw new Error(`Unknown level "${id}". Valid levels: ${rubric.levels.map((l) => l.id).join(', ')}`);
  }
  return level;
}
