// Converts a leveling-guide CSV export into a ladder YAML for /review.
//
//   node scripts/gen-leveling-yaml.mjs <ladder.csv> [out.yaml]
//
// Expected CSV shape: row 0 is the header, columns 2+ are levels titled
// "Title (P1)". Rows listed in CRITERIA below hold each criterion's text per
// level; column A holds "Title\n\nOptional prompt question?". Adjust CRITERIA
// to your sheet's rows. Output defaults to your private config dir, which
// /review reads before the repo's example config.
import fs from 'fs';
import os from 'os';
import path from 'path';

const [src, outArg] = process.argv.slice(2);
if (!src) {
  console.error('usage: node scripts/gen-leveling-yaml.mjs <ladder.csv> [out.yaml]');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'apotheosis');
const out = outArg || path.join(dataDir, 'config', 'leveling.yaml');
fs.mkdirSync(path.dirname(out), { recursive: true });

function parseCsv(s) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(src, 'utf8'));
const header = rows[0];

// Columns 2..8 are the seven levels.
const levels = header.slice(2).map((title) => {
  const m = title.match(/^(.*)\s+\((P\d)\)\s*$/);
  return { code: m[2], id: m[2].toLowerCase(), title: m[1].trim() };
});

// rowIndex -> criterion definition. `prompt` is the italic question in column A.
const CRITERIA = [
  { row: 1,  id: 'role_focus',                    title: 'Role Focus' },
  { row: 3,  id: 'scope',                         title: 'Scope' },
  { row: 4,  id: 'problem_solving',               title: 'Problem Solving' },
  { row: 5,  id: 'autonomy_discretion',           title: 'Discretion & Impact — Autonomy / Discretion', parent: 'discretion_and_impact' },
  { row: 6,  id: 'impact_levers',                 title: 'Discretion & Impact — Impact Levers',         parent: 'discretion_and_impact' },
  { row: 7,  id: 'influence',                     title: 'Discretion & Impact — Influence',             parent: 'discretion_and_impact' },
  { row: 8,  id: 'collaboration_and_interaction', title: 'Collaboration & Interaction' },
  { row: 10, id: 'code_fluency',                  title: 'Craft — Code Fluency',        parent: 'craft' },
  { row: 11, id: 'software_design',               title: 'Craft — Software Design',     parent: 'craft' },
  { row: 12, id: 'architecture_design',           title: 'Craft — Architecture Design', parent: 'craft' },
  { row: 13, id: 'required_experience',           title: 'Required Experience' },
];

// Which Apotheosis evidence feeds each criterion.
const SOURCES = {
  role_focus: ['projects', 'standups'],
  scope: ['projects', 'standups', 'prs', 'meetings'],
  problem_solving: ['standups', 'projects', 'ideas', 'prs', 'ai_usage_wins'],
  autonomy_discretion: ['projects', 'standups', 'meetings'],
  impact_levers: ['projects', 'prs', 'slack_signals'],
  influence: ['slack_signals', 'meetings', 'prs'],
  collaboration_and_interaction: ['slack_signals', 'meetings', 'prs', 'standups'],
  code_fluency: ['prs', 'code_time', 'projects'],
  software_design: ['projects', 'prs', 'ideas', 'standups'],
  architecture_design: ['projects', 'prs', 'meetings', 'ideas'],
  required_experience: [],
};

// Column A holds "Title\n\nItalic question?" for the criteria that have one.
function promptFor(rowIdx) {
  const a = (rows[rowIdx][0] || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return a.length > 1 ? a.slice(1).join(' ') : null;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function block(text, indent) {
  const pad = ' '.repeat(indent);
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  // Literal block keeps the source's paragraph breaks, which carry meaning here.
  return `|-\n${lines.map((l) => (l ? pad + l : '')).join('\n')}`;
}

let y = `# Leveling ladder: Software Engineer IC.
#
# GENERATED FILE. Do not hand-edit.
# Source: ${path.basename(src)}, converted ${new Date().toISOString().slice(0, 10)}.
# Regenerate with scripts/gen-leveling-yaml.mjs.
#
# Expectation text is copied from the sheet and written in the first person.
# The /review page picks a current level and a target level and diffs them.

version: 1
ladder:
  id: software_engineer_ic
  title: Software Engineer IC

levels:
`;

for (const l of levels) {
  y += `  - id: ${l.id}\n    code: ${l.code}\n    title: "${esc(l.title)}"\n`;
}

y += `\ncriteria:\n`;

for (const c of CRITERIA) {
  const prompt = promptFor(c.row);
  y += `  - id: ${c.id}\n    title: "${esc(c.title)}"\n`;
  if (c.parent) y += `    parent: ${c.parent}\n`;
  if (prompt) y += `    prompt: "${esc(prompt)}"\n`;
  const srcs = SOURCES[c.id] ?? [];
  y += `    evidence_sources: [${srcs.join(', ')}]\n`;
  y += `    expectations:\n`;
  for (let i = 0; i < levels.length; i++) {
    const cell = (rows[c.row][i + 2] || '').trim();
    if (!cell) { y += `      ${levels[i].id}: null\n`; continue; }
    y += `      ${levels[i].id}: ${block(cell, 8)}\n`;
  }
  y += `\n`;
}

fs.writeFileSync(out, y);
console.log('wrote', out, fs.statSync(out).size, 'bytes');
