import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPromptRules, loadPolicyRules, matchPolicy, rulesSignature } from '../rules';

let dataDir = '';
let projectRoot = '';

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mh-rules-data-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'mh-rules-proj-'));
  mkdirSync(join(dataDir, 'rules'), { recursive: true });
  writeFileSync(join(dataDir, 'rules', 'tone.md'), '始终用中文回答，代码注释保持英文。');
  writeFileSync(join(projectRoot, 'AGENTS.md'), '---\nname: demo\n---\n本项目禁止修改 kernel/ 目录。');
  mkdirSync(join(projectRoot, '.maharness', 'rules'), { recursive: true });
  writeFileSync(join(projectRoot, '.maharness', 'rules', 'tests.md'), '跑测试只用 npm run test。');
});

after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('loadPromptRules', () => {
  it('全局与项目规则都读到，且项目块在前', () => {
    const r = loadPromptRules({ dataDir, projectRoot });
    assert.match(r.text, /全局规则·tone\.md/);
    assert.match(r.text, /项目规则·AGENTS\.md/);
    assert.match(r.text, /\.maharness\/rules\/tests\.md/);
    assert.ok(r.text.indexOf('项目规则') < r.text.indexOf('全局规则'), '裁剪后项目规则应优先保留');
  });

  it('frontmatter 不进提示词正文', () => {
    const r = loadPromptRules({ dataDir, projectRoot });
    assert.ok(!r.text.includes('name: demo'), `不应包含 frontmatter：${r.text.slice(0, 120)}`);
    assert.ok(r.text.includes('本项目禁止修改 kernel/ 目录。'));
  });

  it('sources 记录不存在文件（供 UI 显示候选）', () => {
    const r = loadPromptRules({ dataDir, projectRoot });
    assert.ok(r.sources.some(s => s.scope === 'project' && !s.exists));
    assert.ok(r.sources.every(s => !s.file.includes('..')));
  });

  it('maxChars 超预算时截断并标记', () => {
    const r = loadPromptRules({ dataDir, projectRoot, maxChars: 30 });
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < 300, `文本应受预算约束，实际 ${r.text.length}`);
  });

  it('签名随内容变化（供插件惰性重载）', () => {
    const a = rulesSignature(loadPromptRules({ dataDir, projectRoot }).sources);
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '新增一条规则');
    const b = rulesSignature(loadPromptRules({ dataDir, projectRoot }).sources);
    assert.notEqual(a, b);
  });
});

describe('策略规则', () => {
  const file = () => join(projectRoot, '.maharness', 'rules.json');
  before(() => {
    writeFileSync(file(), JSON.stringify({
      rules: [
        { id: 'allow-test', effect: 'allow', tool: 'powershell_execute', argPattern: 'npm run (test|typecheck)', reason: '测试免审批' },
        { id: 'allow-read', effect: 'allow', tool: 'read_*', pathPattern: 'docs/**' },
        { id: 'deny-kill', effect: 'deny', tool: 'powershell_execute', argPattern: 'taskkill' },
        { id: 'off', effect: 'allow', tool: 'delete_file', enabled: false },
      ],
    }));
  });

  it('解析并按 tool/argPattern/pathPattern 匹配', () => {
    const { rules, errors } = loadPolicyRules([file()]);
    assert.deepEqual(errors, []);
    assert.equal(rules.length, 4);
    assert.equal(matchPolicy(rules, 'powershell_execute', { command: 'npm run test' })?.id, 'allow-test');
    assert.equal(matchPolicy(rules, 'read_file', { path: 'docs/a.md' })?.id, 'allow-read');
    assert.equal(matchPolicy(rules, 'read_file', { path: 'src/a.ts' }), null);
  });

  it('deny 优先于 allow（后定义者优先）', () => {
    const { rules } = loadPolicyRules([file()]);
    assert.equal(matchPolicy(rules, 'powershell_execute', { command: 'taskkill /PID 1' })?.id, 'deny-kill');
  });

  it('enabled:false 的规则不参与匹配', () => {
    const { rules } = loadPolicyRules([file()]);
    assert.equal(matchPolicy(rules, 'delete_file', { path: 'x.txt' }), null);
  });

  it('坏正则规则视为不匹配而不抛异常', () => {
    const bad = join(projectRoot, 'bad-rules.json');
    writeFileSync(bad, JSON.stringify([{ id: 'b', effect: 'allow', tool: 'write_file', argPattern: '(' }]));
    const { rules } = loadPolicyRules([bad]);
    assert.equal(matchPolicy(rules, 'write_file', { path: 'a' }), null);
  });

  it('损坏的 JSON 报错误而不抛', () => {
    const broken = join(projectRoot, 'broken.json');
    writeFileSync(broken, '{ not json');
    const { rules, errors } = loadPolicyRules([broken]);
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
  });
});
