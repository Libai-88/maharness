import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTaskContract } from '../task-contract';

describe('自然语言任务契约解析', () => {
  test('提取文件验收、风险、时限和预算', () => {
    const now = 1_700_000_000_000;
    const task = deriveTaskContract('请创建 reports/final.md，确保在 10 分钟内完成，预算为 $2', now);
    assert.deepEqual(task.acceptance, [{ type: 'file_exists', path: 'reports/final.md' }]);
    assert.equal(task.risk, 'medium');
    assert.equal(task.deadlineAt, now + 600_000);
    assert.equal(task.costBudgetUsd, 2);
  });

  test('解析明确的绝对截止时间，并在同时给出相对期限时取更早者', () => {
    const absolute = deriveTaskContract('请生成报告，截止时间为 2027-01-02T15:30:00Z', 1_700_000_000_000);
    assert.equal(absolute.deadlineAt, Date.parse('2027-01-02T15:30:00Z'));
    const earlier = deriveTaskContract('请生成报告，within 10 分钟，by 2027-01-02T15:30:00Z', 1_700_000_000_000);
    assert.equal(earlier.deadlineAt, 1_700_000_000_000 + 600_000);
  });

  test('只从明确引号短语提取输出验收，不猜测普通问句', () => {
    const task = deriveTaskContract('请回答，并且必须包含“结论：通过”');
    assert.deepEqual(task.acceptance, [{ type: 'output_contains', value: '结论：通过' }]);
    assert.deepEqual(task.inference, { confidence: 1, basis: 'explicit', needsConfirmation: false, rationale: '目标包含可直接验证的明确验收条件' });
    assert.equal(deriveTaskContract('今天北京天气怎么样？').acceptance.length, 0);
  });

  test('开放式行动目标只产生低置信度推断，并要求确认', () => {
    const task = deriveTaskContract('请整理一份项目报告');
    assert.deepEqual(task.acceptance, []);
    assert.deepEqual(task.inference, { confidence: 0.45, basis: 'inferred', needsConfirmation: true, rationale: '识别到行动意图，但未识别到可验证的完成标准' });
  });

  test('开放式问题标记为歧义，不能单独触发验收', () => {
    const task = deriveTaskContract('今天北京天气怎么样？');
    assert.deepEqual(task.inference, { confidence: 0.1, basis: 'ambiguous', needsConfirmation: true, rationale: '目标是询问或开放式问题，缺少可验证的完成标准' });
    assert.equal(task.acceptance.length, 0);
  });

  test('识别常见中英文明确输出格式并规范化空白', () => {
    assert.deepEqual(deriveTaskContract('请输出内容为「  READY  」').acceptance, [
      { type: 'output_contains', value: 'READY' },
    ]);
    assert.deepEqual(deriveTaskContract('output exactly as "done"').acceptance, [
      { type: 'output_contains', value: 'done' },
    ]);
  });

  test('识别带引号的回答/返回表达式，同时拒绝无明确短语的普通问句', () => {
    assert.deepEqual(deriveTaskContract('请回答「已完成」').acceptance, [
      { type: 'output_contains', value: '已完成' },
    ]);
    assert.deepEqual(deriveTaskContract('respond with "READY" and must contain \'trace-id\'').acceptance, [
      { type: 'output_contains', value: 'READY' },
      { type: 'output_contains', value: 'trace-id' },
    ]);
    assert.equal(deriveTaskContract('请回答这个问题，并解释原因').acceptance.length, 0);
  });

  test('识别明确标记的中英文正则输出验收，并保留 flags', () => {
    assert.deepEqual(deriveTaskContract('最终回答匹配正则 "^REF-[0-9]{6}$"').acceptance, [
      { type: 'output_matches', pattern: '^REF-[0-9]{6}$' },
    ]);
    assert.deepEqual(deriveTaskContract('answer matches /^ready$/i').acceptance, [
      { type: 'output_matches', pattern: '^ready$', flags: 'i' },
    ]);
    assert.deepEqual(deriveTaskContract('输出符合正则 /^ok$/i；输出符合正则 /^ok$/i').acceptance, [
      { type: 'output_matches', pattern: '^ok$', flags: 'i' },
    ]);
  });

  test('非法正则和普通匹配问句不生成正则验收', () => {
    assert.equal(deriveTaskContract('最终回答匹配正则 "["').acceptance.length, 0);
    assert.equal(deriveTaskContract('请判断 answer matches this value').acceptance.length, 0);
  });

  test('按出现顺序提取多项输出短语和文件产物，并去重', () => {
    const task = deriveTaskContract('必须包含“alpha”，include the phrase "beta"，必须包含“alpha”；创建 reports/one.md 并生成 reports/two.json，再创建 reports/one.md');
    assert.deepEqual(task.acceptance, [
      { type: 'output_contains', value: 'alpha' },
      { type: 'output_contains', value: 'beta' },
      { type: 'file_exists', path: 'reports/one.md' },
      { type: 'file_exists', path: 'reports/two.json' },
    ]);
  });

  test('提取明确的文件内容和工具成功条件，并去重', () => {
    const task = deriveTaskContract('请确认文件 reports/result.md 包含“已完成”，且工具 write_file 执行成功；工具 write_file 成功。');
    assert.deepEqual(task.acceptance, [
      { type: 'file_contains', path: 'reports/result.md', value: '已完成' },
      { type: 'tool_succeeded', name: 'write_file' },
    ]);
  });

  test('普通提及文件或工具时不猜测内容验收', () => {
    assert.equal(deriveTaskContract('请读取 reports/result.md，并了解工具 write_file 的用法').acceptance.length, 0);
  });

  test('否定表达式不生成相反的验收条件', () => {
    assert.equal(deriveTaskContract('请不要包含“内部草稿”，也不要创建 reports/draft.md').acceptance.length, 0);
    assert.equal(deriveTaskContract('工具 write_file 不需要执行成功').acceptance.length, 0);
    assert.equal(deriveTaskContract('文件 reports/result.md 不包含“失败”').acceptance.length, 0);
  });

  test('忽略零值或溢出的预算与期限', () => {
    const invalid = deriveTaskContract('预算为 $0，within 0 秒', 1000);
    assert.equal(invalid.costBudgetUsd, undefined);
    assert.equal(invalid.deadlineAt, undefined);
    const overflow = deriveTaskContract('budget 1e999 usd', 1000);
    assert.equal(overflow.costBudgetUsd, undefined);
  });

  test('拒绝绝对路径和带点段的路径作为文件验收条件', () => {
    assert.equal(deriveTaskContract('请生成 C:\\secret\\out.txt').acceptance.length, 0);
    assert.equal(deriveTaskContract('请创建 ../secret/out.txt').acceptance.length, 0);
    assert.equal(deriveTaskContract('请写入 ./out.txt').acceptance.length, 0);
  });

  test('拒绝绝对路径作为可自动验证的沙箱路径', () => {
    const task = deriveTaskContract('请生成 C:\\secret\\out.txt');
    assert.equal(task.acceptance.length, 0);
  });
});
