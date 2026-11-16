import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffPolicyRules, dryRunPolicy, evaluatePolicy, loadPromptRules, loadPolicyRules,
  matchPolicy, resolveRuleDescriptors, rulesSignature, validatePolicyRules,
} from '../rules';
import type { RuleDescriptor } from '../types';

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

  it('相同内容的全局与项目规则保留冲突来源，并裁决项目优先', () => {
    const localData = mkdtempSync(join(tmpdir(), 'mh-rules-duplicate-data-'));
    const localProject = mkdtempSync(join(tmpdir(), 'mh-rules-duplicate-project-'));
    try {
      const duplicate = '始终使用项目规则。';
      mkdirSync(join(localData, 'rules'), { recursive: true });
      writeFileSync(join(localData, 'rules', 'global.md'), duplicate);
      writeFileSync(join(localProject, 'AGENTS.md'), duplicate);
      const result = loadPromptRules({ dataDir: localData, projectRoot: localProject });
      assert.equal(result.text.split(duplicate).length - 1, 1);
      assert.equal(result.resolution.applied[0]?.source, 'project');
      assert.ok(result.resolution.conflicts.some(conflict =>
        conflict.reason === 'same_content_duplicate' && conflict.winner.startsWith('rules:project:')));
    } finally {
      rmSync(localData, { recursive: true, force: true });
      rmSync(localProject, { recursive: true, force: true });
    }
  });
});

describe('结构化规则裁决', () => {
  test('按优先级去重、记录冲突和未生效来源', () => {
    const rule = (id: string, source: RuleDescriptor['source'], priority: number, hash: string, active = true): RuleDescriptor => ({
      id, label: id, source, scope: source === 'runtime' ? 'runtime' : 'workspace', priority,
      trust: source === 'runtime' || source === 'user' || source === 'project' ? 'user' : 'reference',
      contentHash: hash, active,
    });
    const result = resolveRuleDescriptors([
      rule('project', 'project', 600, 'same'),
      rule('user-rule', 'user', 700, 'same'),
      rule('skill', 'skill', 200, 'skill'),
      rule('disabled', 'plugin', 900, 'disabled', false),
    ]);
    assert.deepEqual(result.applied.map(item => item.id), ['user-rule', 'skill']);
    assert.deepEqual(result.ignored.map(item => item.id), ['disabled', 'project']);
    assert.deepEqual(result.conflicts[0], { left: 'user-rule', right: 'project', reason: 'same_content_duplicate', winner: 'user-rule' });
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

  it('evaluatePolicy 返回默认判定与命中原因', () => {
    const { rules } = loadPolicyRules([file()]);
    const allowed = evaluatePolicy(rules, 'powershell_execute', { command: 'npm run test' });
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.matched, true);
    assert.equal(allowed.ruleId, 'allow-test');
    assert.equal(allowed.reason, '测试免审批');
    const fallback = evaluatePolicy(rules, 'write_file', { path: 'src/a.ts' });
    assert.equal(fallback.decision, 'default');
    assert.equal(fallback.matched, false);
  });

  it('diffPolicyRules 识别新增、删除与字段变化', () => {
    const before = [
      { id: 'keep', effect: 'allow' as const, tool: 'read_file' },
      { id: 'change', effect: 'allow' as const, tool: 'write_file', pathPattern: 'docs/**' },
      { id: 'remove', effect: 'deny' as const, tool: 'delete_file' },
    ];
    const after = [
      { id: 'keep', effect: 'allow' as const, tool: 'read_file' },
      { id: 'change', effect: 'deny' as const, tool: 'write_file', pathPattern: 'src/**' },
      { id: 'add', effect: 'allow' as const, tool: 'powershell_execute', argPattern: 'npm run test' },
    ];
    const changes = diffPolicyRules(before, after);
    assert.deepEqual(changes.map((item) => [item.id, item.change]).sort(), [
      ['add', 'added'], ['change', 'changed'], ['remove', 'removed'],
    ]);
    assert.deepEqual(changes.find((item) => item.id === 'change')?.fields, ['effect', 'pathPattern']);
  });

  it('validatePolicyRules 拒绝非法规则并提示通配 allow', () => {
    const issues = validatePolicyRules([
      { id: 'bad-regex', effect: 'allow', tool: 'read_file', argPattern: '(' },
      { id: 'blanket', effect: 'allow', tool: '*' },
      { id: 'dup', effect: 'deny', tool: 'delete_file' },
      { id: 'dup', effect: 'deny', tool: 'delete_file' },
    ]);
    assert.ok(issues.some((issue) => issue.code === 'invalid-regex' && issue.level === 'error'));
    assert.ok(issues.some((issue) => issue.code === 'blanket-allow' && issue.level === 'warning'));
    assert.ok(issues.some((issue) => issue.code === 'duplicate-id' && issue.level === 'warning'));
  });

  it('dryRunPolicy 只读比较候选策略且不改变输入', () => {
    const current = [
      { id: 'allow-test', effect: 'allow' as const, tool: 'powershell_execute', argPattern: 'npm run test' },
    ];
    const candidate = [
      { id: 'allow-test', effect: 'deny' as const, tool: 'powershell_execute', argPattern: 'npm run test' },
    ];
    const before = JSON.stringify(current);
    const result = dryRunPolicy(current, candidate, [{ tool: 'powershell_execute', args: { command: 'npm run test' } }]);
    assert.equal(result.current[0].decision, 'allow');
    assert.equal(result.candidate[0].decision, 'deny');
    assert.equal(result.changed, true);
    assert.equal(result.diff[0].change, 'changed');
    assert.equal(JSON.stringify(current), before);
  });
});
