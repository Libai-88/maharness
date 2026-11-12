/**
 * 技能路由评测门禁：用同一套 scoreSkillEntries 对固定 prompt 做可重复的 top-K 检查。
 * 这不是模型行为评测，而是「技能索引是否会选错」的确定性回归；真实模型评测仍走 eval:ci。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, fmString, fmList } from '../kernel/frontmatter';
import { scoreSkillEntries, topSkills, type SkillRouteEntry } from '../core/skills/router';

interface EvalCase {
  prompt: string;
  expect: string;
  topK?: number;
  forbid?: string[];
}

interface EvalFile {
  version?: number;
  cases: EvalCase[];
}

function findSkillFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || !existsSync(dir)) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findSkillFiles(full, depth + 1, out);
    else if (entry.name === 'SKILL.md') out.push(full);
  }
  return out;
}

function readSkills(root: string): SkillRouteEntry[] {
  const out: SkillRouteEntry[] = [];
  for (const file of findSkillFiles(root)) {
    try {
      const fm = parseFrontMatter(readFileSync(file, 'utf8'));
      const name = fmString(fm.data, 'name') || basename(dirname(file));
      const description = fmString(fm.data, 'description') || '';
      out.push({
        name,
        description,
        triggers: fmList(fm.data, 'triggers'),
        appliesWhen: fmList(fm.data, 'applies-when').length ? fmList(fm.data, 'applies-when') : fmList(fm.data, 'applies_when'),
        rejectWhen: fmList(fm.data, 'reject-when').length ? fmList(fm.data, 'reject-when') : fmList(fm.data, 'reject_when'),
      });
    } catch { /* 单个技能损坏不阻断其余评测 */ }
  }
  return out;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const evalFile = resolve(process.argv[2] ?? join(root, 'skills-evals.json'));
const evalData = JSON.parse(readFileSync(evalFile, 'utf8')) as EvalFile;
if (!Array.isArray(evalData.cases) || evalData.cases.length === 0) {
  console.error('技能评测文件没有 cases');
  process.exit(2);
}

const skills = [
  ...readSkills(join(root, 'core', 'skills', 'builtin')),
  ...readSkills(join(root, 'vendor')),
  ...readSkills(join(root, 'data', 'skills')),
];
const byName = new Map<string, SkillRouteEntry>();
for (const skill of skills) byName.set(skill.name, skill);
const entries = [...byName.values()];
if (!entries.length) {
  console.error('没有发现可评测的技能');
  process.exit(2);
}

let failed = 0;
for (const item of evalData.cases) {
  const topK = Math.max(1, Math.trunc(item.topK ?? 3));
  const ranked = topSkills(scoreSkillEntries(entries, item.prompt), topK);
  const names = ranked.map((entry) => entry.name);
  const expectOk = names.includes(item.expect);
  const forbidden = (item.forbid ?? []).filter((name) => names.includes(name));
  if (!expectOk || forbidden.length) {
    failed++;
    console.error(`FAIL ${JSON.stringify(item.prompt)}`);
    console.error(`  top${topK}: ${names.join(', ') || '(空)'}`);
    console.error(`  expect: ${item.expect}${expectOk ? '' : '（未进入 topK）'}`);
    if (forbidden.length) console.error(`  forbidden in topK: ${forbidden.join(', ')}`);
  } else {
    console.log(`PASS ${JSON.stringify(item.prompt)} → ${names.join(', ')}`);
  }
}

console.log(`\n[skill-eval] ${evalData.cases.length - failed}/${evalData.cases.length} 通过（技能 ${entries.length} 个）`);
process.exit(failed ? 1 : 0);
