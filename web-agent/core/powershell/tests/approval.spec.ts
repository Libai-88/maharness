import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessCommand, isReadOnlyCommand } from '../index';

describe('PowerShell 只读判定（免审批白名单）', () => {
  const free = [
    'Get-ChildItem',
    'Get-Content README.md | Select-String foo',
    'git status',
    'git log --oneline -10',
    'git diff HEAD~1',
    'git show 8c4f305',
    'git branch --list',
    'git remote -v',
    'git config --get user.name',
    'npm run test',
    'npm run typecheck',
    'npm test',
    'npm ls --depth=0',
    'rg -n "class Foo"',
    'node --version',
    'python --version',
    'pip list',
  ];
  for (const cmd of free) {
    it(`免审批: ${cmd}`, () => {
      assert.equal(assessCommand(cmd).needsApproval, false, `${cmd} 应免审批`);
    });
  }
});

describe('PowerShell 需审批判定（默认拒绝）', () => {
  const gated = [
    'Remove-Item x',
    'del x',
    'Set-Content a.txt -Value hi',
    'Get-ChildItem > list.txt',
    'Invoke-Expression "write-host hi"',
    'git commit -m "msg"',
    'git push origin main',
    'git checkout -b feature',
    'git branch -D old',
    'git stash',
    'npm install lodash',
    'npx some-tool',
    'npm run build',
    'node script.js',
    'Get-Content .env',
    'Get-Content data/agent.db',
    'Stop-Process -Name node',
  ];
  for (const cmd of gated) {
    it(`需审批: ${cmd}`, () => {
      assert.equal(assessCommand(cmd).needsApproval, true, `${cmd} 应需审批`);
    });
  }
});

describe('分段判定不被拼接命令绕过', () => {
  it('&& 链中的写命令使整条命令需审批', () => {
    assert.equal(isReadOnlyCommand('git status && Remove-Item -Recurse x'), false);
    assert.equal(assessCommand('git status && Remove-Item x').needsApproval, true);
  });
  it('|| 与换行同样拆段', () => {
    assert.equal(isReadOnlyCommand('git diff || npm install'), false);
    assert.equal(isReadOnlyCommand('Get-ChildItem\nnpm install'), false);
  });
  it('只读链保持免审批', () => {
    assert.equal(isReadOnlyCommand('git status && git log --oneline'), true);
  });
  it('空命令不放行', () => {
    assert.equal(isReadOnlyCommand('   '), false);
  });
});
