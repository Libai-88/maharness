/**
 * core/powershell/tests/approval-bypass.spec.ts —— A1（白名单绕过）与 A10（误拦）回归
 *
 * A1 的失败形态：判定只看每段首 token 是否在只读白名单，**参数位的内容完全不参与判定**。
 * PowerShell 的参数位就是代码（脚本块、子表达式、`[Type]::Member()`），于是
 * `Get-ChildItem | Where-Object { [IO.File]::Delete('x') }` 两段首词都在白名单 → 免审批，
 * 等于把「审批不可绕过」这条承诺打穿（README 的安全模型一节明写"机器强制"）。
 *
 * A10 的失败形态是反方向的：黑名单把 `2>$null`、字符串里的 `>` 当重定向写文件，
 * 拆段又不感知引号，把 `Select-String 'a|b'` 拆成两段 → 正常只读命令反复弹审批，
 * 用户习惯性点"可以"，审批卡的可信度被稀释。两条必须一起修。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessCommand, isReadOnlyCommand, scriptBlockIsSafe, hasExecutableConstruct } from '../index';

describe('A1：脚本块/成员调用不得借只读白名单免审批', () => {
  const payloads = [
    // 报告里坐实的四个
    `Get-ChildItem | Where-Object { [IO.File]::Delete('D:\\tmp\\x.txt') }`,
    `Get-ChildItem | Where-Object { [System.IO.File]::WriteAllText('D:\\tmp\\pwn.txt','x') }`,
    `Get-ChildItem | Where-Object { [System.Diagnostics.Process]::Start('cmd.exe','/c calc.exe') }`,
    `Get-ChildItem | Select-Object @{n='x';e={[System.IO.File]::Delete('D:\\tmp\\x')}}`,
    // 同一缺口的其它入口
    `Get-ChildItem | ForEach-Object { Remove-Item $_ }`,
    `dir | Where-Object { [scriptblock]::Create('calc.exe') }`,
    `Get-Content a.txt | Where-Object { $(Invoke-Expression 'x') }`,
    `Get-ChildItem -Recurse | Where-Object { New-Object System.IO.FileInfo 'x' }`,
    `Get-ChildItem | Where-Object { $_.Name -eq 'a' ; Remove-Item $_ }`,   // 脚本块内多语句
    `Get-Process | Where-Object { $_.Name -eq 'a' } | ForEach-Object { $_.Kill() }`,
    `$x = Get-Process`,                                                    // 变量赋值
    `& calc.exe`,                                                         // 调用运算符
    `Get-ChildItem (& calc.exe)`,                                                // 参数位调用运算符
  ];
  for (const cmd of payloads) {
    it(`需审批: ${cmd.slice(0, 56)}`, () => {
      assert.equal(isReadOnlyCommand(cmd), false, `${cmd} 不得判为只读`);
      assert.equal(assessCommand(cmd).needsApproval, true, `${cmd} 必须请求用户审批`);
    });
  }

  it('判定给出可读原因（审批卡要说明为什么拦）', () => {
    const r = assessCommand(`Get-ChildItem | Where-Object { [IO.File]::Delete('x') }`);
    assert.ok(r.reason && r.reason !== '不在只读白名单内', `reason=${r.reason}`);
  });
});

describe('A10：安全子集只读命令不得被误拦', () => {
  const free = [
    'Get-ChildItem',
    'Get-ChildItem | Where-Object { $_.Name -like \'*.ts\' }',
    'Get-ChildItem -Recurse | Where-Object { $_.PSIsContainer -eq $false } | Select-Object -First 5',
    'Get-Process | Where-Object { $_.WorkingSet64 -gt 100000000 } | Sort-Object -Descending WorkingSet64 | Select-Object -First 5 Name,WorkingSet64',
    'Get-Content a.txt | Select-String \'a|b\'',        // 引号内的 | 不是管道
    'Get-Content README.md | Select-String \'foo > bar\'', // 引号内的 > 不是重定向
    'Get-ChildItem 2>$null | Measure-Object',            // 丢弃错误流不是写文件
    'Get-ChildItem | Sort-Object Length -Descending | Select-Object -First 3 Name',
    'Get-Date -Format \'yyyy-MM-dd HH:mm:ss\'',
    'git status | Select-String modified',
    'npm run typecheck',
    'rg -n "class Foo"',
  ];
  for (const cmd of free) {
    it(`免审批: ${cmd.slice(0, 60)}`, () => {
      assert.equal(assessCommand(cmd).needsApproval, false, `${cmd} 应免审批（reason=${assessCommand(cmd).reason}）`);
    });
  }
});

describe('脚本块安全子集（单元级）', () => {
  const safe = [
    ' $_.Name -like \'*.log\' ',
    ' $_.PSIsContainer -eq $false ',
    ' $_.Length -gt 1000 -or $_.Name -match \'x\' ',
    ' ',
  ];
  for (const b of safe) {
    it(`安全: ${JSON.stringify(b.trim())}`, () => assert.equal(scriptBlockIsSafe(b), true));
  }
  const unsafe = [
    " [IO.File]::Delete('x') ",
    ' $(Get-Random) ',
    ' @{n=\'x\';e={1}} ',
    ' $_.Name -eq \'a\' ; Remove-Item $_ ',
    ' New-Object System.IO.StreamWriter \'x\' ',
    ' $_.Kill() ',
    " $_ = 'x' ",
    ' & calc.exe ',
  ];
  for (const b of unsafe) {
    it(`不安全: ${JSON.stringify(b.trim())}`, () => assert.equal(scriptBlockIsSafe(b), false));
  }

  it('花括号不配对按「含代码」处理（不可判定即拦）', () => {
    assert.equal(hasExecutableConstruct('Get-ChildItem | Where-Object { $_.Name -eq ').hit, true);
  });
});
