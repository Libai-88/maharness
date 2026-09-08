/**
 * core/powershell/index.ts —— PowerShell 执行器插件（Windows 原生能力）
 * 安全机制（白名单 + 审批，默认拒绝模型）：
 *  1. 只读白名单：整条命令按 | 和 ; 分段，每段首 token 都在白名单（只读 cmdlet/别名）
 *     才免审批直接执行；任一段非白名单 → 弹审批卡片等待用户批准（C2/H1）
 *  2. 黑名单兜底：白名单命中但整条命令含危险模式（如 Invoke-Expression）→ 仍需审批
 *  3. cwd 锚定沙箱根：进程工作目录固定在 tctx.sandboxRoot（不再全盘游走）
 *  4. 超时自动杀进程树（默认 15s，上限 60s）；输出截断 8KB，UTF-8，Trace 全程审计
 */
import { spawn } from 'node:child_process';
import type { Plugin, ToolContext } from '../../kernel/types';

/** 只读可执行程序 / cmdlet 别名（首 token 命中且无写副作用即免审批） */
const READONLY_EXE = new Set([
  'get-childitem', 'get-item', 'get-itemproperty', 'get-content', 'get-process', 'get-service',
  'get-date', 'get-location', 'select-string', 'measure-object', 'where-object', 'sort-object',
  'select-object', 'format-list', 'format-table', 'get-command', 'get-member', 'test-path',
  'resolve-path', 'ls', 'dir', 'cat', 'type', 'whoami', 'hostname', 'pwd', 'tree', 'echo', 'findstr', 'rg',
]);

/** git 只读子命令（无位置参数副作用） */
const GIT_READONLY_SUBS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'blame',
  'cat-file', 'shortlog', 'count-objects', 'reflog', 'rev-list', 'diff-tree', 'grep', 'whatchanged',
]);
/** git 需要按参数细分的子命令及其允许旗标 */
const GIT_SUB_FLAGS: Record<string, string[]> = {
  branch: ['-l', '--list', '-a', '--all', '-r', '--remotes', '-vv', '-v'],
  tag: ['-l', '--list'],
  remote: ['-v', '--verbose', '-n'],
  config: ['--get', '--get-regexp', '--list', '-l'],
};
/** npm/pnpm/yarn 免审批的脚本名（test/typecheck/lint 是编程日常主力） */
const NPM_READ_SCRIPTS = new Set(['test', 'typecheck', 'lint', 'eval', 'selftest', 'ls', 'outdated', 'doctor', 'view', 'why', 'help']);

/** 敏感文件模式（H10：白名单读命令触及密钥/内部数据也强制审批，堵住 Get-Content .env 免审批直读） */
const SENSITIVE_READ_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\.env\b/i, reason: '读取 .env 密钥文件' },
  { pattern: /\bagent\.db\b/i, reason: '读取内部数据库（含 provider 密钥明文）' },
  { pattern: /\bsecret\.key\b/i, reason: '读取主密钥文件' },
];

/** 危险操作黑名单（第二道兜底：白名单命中但含危险词 → 仍需用户审批） */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(Remove-Item|Remove-ChildItem|Remove-ItemProperty|Remove-Variable)\b/i, reason: '删除文件/目录/属性' },
  { pattern: /\b(Set-Content|Add-Content|Clear-Content|Out-File|Copy-Item|Move-Item|Rename-Item)\b/i, reason: '写入/覆盖/移动文件' },
  { pattern: />{1,2}\s*\S/, reason: '重定向写文件' },
  { pattern: /(Format-Volume|format\s+[a-zA-Z]:)/i, reason: '格式化磁盘' },
  { pattern: /\b(Stop-Process|Stop-Service|taskkill)\b/i, reason: '终止进程/服务' },
  { pattern: /\b(Restart-Computer|Stop-Computer|shutdown|restart)\b/i, reason: '关机/重启' },
  { pattern: /\b(reg\s+(add|delete)|Set-ItemProperty|Remove-ItemProperty)\b/i, reason: '修改注册表' },
  { pattern: /\b(Invoke-WebRequest|Invoke-Expression|iex|Start-BitsTransfer|certutil|wget|curl)\b/i, reason: '下载/执行外部内容' },
  { pattern: /\b(diskpart|mountvol)\b/i, reason: '磁盘分区操作' },
  { pattern: /\b(Set-MpPreference|Set-MpThreatDefaultAction|sc\s+stop|net\s+stop)\b/i, reason: '停用安全防护/系统服务' },
  { pattern: /\b(Enable-PSRemoting|New-SelfSignedCertificate|Clear-EventLog)\b/i, reason: '高危系统操作' },
  { pattern: /\b(npx|npm\s+(install|i|add|uninstall|link|publish)|pip\s+install|pnpm\s+(add|install))\b/i, reason: '安装/执行外部代码' },
];

/** 取命令段的首 token：去调用运算符 &/引号，含完整路径时取文件名，统一小写 */
function firstTokenOf(segment: string): string {
  const raw = segment.trim().split(/\s+/)[0] ?? '';
  const cleaned = raw.replace(/^&/, '').replace(/^["']|["']$/g, '');
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return base.toLowerCase();
}

/** 拆段：管道 | 分号 ; 逻辑与/或 && || 以及换行——每段独立判定，防止 `git status && rm -rf x` 借首段蒙混 */
function splitSegments(command: string): string[] {
  return command.split(/(?:\|\||&&|[|;\n])/g).map(s => s.trim()).filter(s => s !== '');
}

function segmentTokens(seg: string): { exe: string; args: string[] } {
  const parts = seg.trim().split(/\s+/);
  const args = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ''));
  return { exe: firstTokenOf(seg), args };
}

/** git：只读子命令直接放行；branch/tag/remote/config 需按旗标细分；任何改写工作树的调用拒绝 */
function gitIsReadOnly(args: string[]): boolean {
  const sub = args[0];
  if (!sub) return false;
  const rest = args.slice(1);
  if (rest.some(a => a === '-C' || a === '--git-dir' || a === '--work-tree' || a.startsWith('--output'))) return false;
  if (sub === 'config') return GIT_SUB_FLAGS.config.includes(args[1] ?? '');
  if (GIT_READONLY_SUBS.has(sub)) return true;
  const allow = GIT_SUB_FLAGS[sub];
  if (!allow) return false;
  const flags = rest.filter(a => a.startsWith('-'));
  const positionals = rest.filter(a => !a.startsWith('-'));
  if (positionals.length) return false;          // 带位置参数（分支名/标签名）→ 交给审批
  return flags.every(f => allow.includes(f));
}

function npmIsReadOnly(args: string[]): boolean {
  const head = args[0] ?? '';
  if (head === 'run') return NPM_READ_SCRIPTS.has(args[1] ?? '');
  return ['test', 'ls', 'outdated', 'doctor', 'view', 'why', 'help'].includes(head);
}

/** 单段是否只读（首 token 命中白名单，或属于可细分的只读 CLI 子命令） */
function segmentIsReadOnly(seg: string): boolean {
  const { exe, args } = segmentTokens(seg);
  if (exe === '') return false;
  if (READONLY_EXE.has(exe)) return true;
  if (exe === 'git') return gitIsReadOnly(args);
  if (exe === 'npm' || exe === 'pnpm' || exe === 'yarn') return npmIsReadOnly(args);
  if (exe === 'node' || exe === 'python' || exe === 'python3' || exe === 'py') return args.length === 1 && /^(-v|--version)$/.test(args[0]);
  if (exe === 'pip' || exe === 'pip3') return ['list', 'show', 'check'].includes(args[0] ?? '');
  return false;
}

/** 白名单判定：整条命令每一段都是只读 → 免审批 */
export function isReadOnlyCommand(command: string): boolean {
  const segs = splitSegments(command);
  return segs.length > 0 && segs.every(segmentIsReadOnly);
}

/**
 * 命令审批判定（纯函数，供 selftest 等外部复用，不实际 spawn）：
 * C2/H1 白名单模型——全部分段只读 → 免审批；否则一律需审批。
 * 黑名单兜底：白名单命中但含危险词（如 Invoke-Expression）仍需审批。
 * 敏感文件兜底：白名单读命令触及 .env/agent.db 也强制审批（防绕过文件工具读拒）。
 */
export function assessCommand(command: string): { needsApproval: boolean; reason: string } {
  const readOnly = isReadOnlyCommand(command);
  const hit = DANGEROUS_PATTERNS.find((d) => d.pattern.test(command));
  const sensitive = SENSITIVE_READ_PATTERNS.find((d) => d.pattern.test(command));
  return {
    needsApproval: !readOnly || !!hit || !!sensitive,
    reason: hit?.reason ?? sensitive?.reason ?? '不在只读白名单内',
  };
}

const MAX_OUTPUT = 8000;

/** env_probe 内置探测清单：覆盖编程与办公文档链路常用工具 */
const PROBE_DEFAULTS = [
  'git', 'node', 'npm', 'npx', 'pnpm', 'bun', 'python', 'python3', 'pip', 'rg', 'jq', 'tar', 'zip', '7z',
  'pandoc', 'soffice', 'libreoffice', 'pdftotext', 'pdfinfo', 'docker', 'sqlite3', 'code', 'go', 'cargo', 'dotnet',
];
const PROBE_VER = 'v1';

interface PsResult { code: number; stdout: string; stderr: string }

/** 执行 PowerShell（UTF-8 输出、可超时、可杀进程树、cwd 锚定沙箱根） */
function runPowershell(command: string, timeoutMs: number, cwd: string): Promise<PsResult> {
  return new Promise((resolve, reject) => {
    // OutputEncoding 保证 stdout 按 UTF-8 输出（Windows 控制台默认 GBK）
    const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; ${command}`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
      windowsHide: true,
      cwd, // 工作目录锚定沙箱根：相对路径命令不再全盘游走
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 杀整个进程树（Windows 下 kill() 不杀子进程）
      try { spawn('taskkill', ['/PID', String(ps.pid), '/T', '/F'], { windowsHide: true }); } catch { /* 忽略 */ }
      reject(new Error(`命令执行超时（${timeoutMs / 1000}s），已终止`));
    }, timeoutMs);
    ps.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    ps.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    ps.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    ps.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export default {
  id: 'powershell',
  name: 'PowerShell 执行器',
  version: '0.1.0',
  onLoad(ctx) {
    // L2 插件自述：约束 LLM 使用 PowerShell 的纪律
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'powershell-rules',
        name: 'PowerShell 使用纪律',
        description: '约束 LLM 安全使用 PowerShell 工具',
        priority: 10,
        content: [
          'PowerShell 工具使用规则：',
          '1. 执行命令前先说明意图；输出过长会自动截断；',
          '2. 只读调用（cmdlet 白名单、git 只读子命令、npm run test/typecheck/lint、rg）免审批直接执行；其余命令（写入/删除/安装/下载等）都会弹出审批卡片，等待用户批准后自动执行；',
          '3. 被拦截时向用户说明原因，等待用户在界面批准；不要自行绕过、不要诱导用户批准；',
          '4. 需要管理员权限的操作会失败，提示用户以管理员身份运行；',
          '5. 不要用 PowerShell 读取 .env、密钥等敏感文件内容，除非用户明确要求。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'powershell_execute',
        risk: 'high',
        costHint: 'medium',
        approval: true,
        limits: '命令超时 60s；只读命令免审批，写入/安装/删除类需用户审批',
        output: '{stdout, stderr, exitCode}；exitCode=0 表示成功',
        description: '在 Windows 上执行 PowerShell 命令并返回输出（工作目录锚定沙箱根）。审批语义（按参数动态判定，默认需审批）：'
          + '只读调用免审批直接执行——包括 cmdlet 白名单（Get-ChildItem/Get-Content/Select-String/Get-Command 等，管道每段都只读）、'
          + '`git status|diff|log|show|ls-files|rev-parse|blame|grep` 等只读子命令、`npm run test|typecheck|lint`、`rg`、`node --version`；'
          + '按 | ; && || 拆段后任一段非只读，或命令含危险模式（删除/覆盖/重定向写/杀进程/下载执行/注册表/npx/npm install 等）'
          + '→ 拦截并请求用户审批，批准后自动执行。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'PowerShell 命令（一行或分号分隔）' },
            timeoutSec: { type: 'number', description: '超时秒数（默认 15，最大 60）' },
          },
          required: ['command'],
        },
        assessApproval(args) {
          const command = String((args as { command?: string })?.command ?? '').trim();
          if (!command) return { needsApproval: false, reason: '' };
          return assessCommand(command);
        },
        async handler(args: { command?: string; timeoutSec?: number }, tctx: ToolContext) {
          const command = String(args.command ?? '').trim();
          if (!command) return { ok: false, error: '命令不能为空' };
          const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 15, 1), 60);

          const { needsApproval, reason } = assessCommand(command);
          if (needsApproval && tctx.approved) {
            // 已获用户批准：审计留痕
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'system', name: '危险命令已获用户批准' })
              .finish({ outputSummary: `[${reason}] ${command.slice(0, 300)}` });
          }

          try {
            const r = await runPowershell(command, timeoutSec * 1000, tctx.sandboxRoot);
            const combined = (r.stdout + (r.stderr.trim() ? `\n[stderr] ${r.stderr.trim()}` : '')).slice(0, MAX_OUTPUT);
            const truncated = combined.length >= MAX_OUTPUT;
            if (r.code === 0) {
              return { ok: true, data: { exitCode: r.code, output: combined, truncated } };
            }
            return { ok: false, error: `命令退出码 ${r.code}${combined ? `：\n${combined}` : ''}` };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'env_probe',
        risk: 'low',
        costHint: 'low',
        limits: '默认只做 Get-Command 探测（不执行程序）；withVersion=true 会执行 --version，需用户审批',
        output: '{platform, node, tools: [{name, found, path?, version?}]}',
        description: '探测本机可用工具链（git/node/npm/python/pandoc/libreoffice/rg 等）。用于判断能否用本机程序完成 docx/xlsx/pdf 转换、是否装了 ripgrep/git 等；结果按 L2 缓存。',
        parameters: {
          type: 'object',
          properties: {
            commands: { type: 'array', items: { type: 'string' }, description: `要探测的命令名，缺省探测内置清单（${PROBE_DEFAULTS.length} 项）` },
            withVersion: { type: 'boolean', description: '是否顺带执行 --version 读取版本号（默认 false）' },
          },
        },
        assessApproval(args) {
          return (args as { withVersion?: boolean })?.withVersion
            ? { needsApproval: true, reason: '将执行本机程序的 --version 命令' }
            : { needsApproval: false, reason: '' };
        },
        async handler(args: { commands?: string[]; withVersion?: boolean }, tctx: ToolContext) {
          const wanted = (args.commands ?? []).map(c => String(c).trim()).filter(c => /^[A-Za-z0-9_.+-]{1,32}$/.test(c));
          const cmds = wanted.length ? wanted : PROBE_DEFAULTS;
          const withVersion = !!args.withVersion;
          const key = tctx.cache.makeKey(['env_probe', PROBE_VER, cmds.join(','), withVersion ? 'v' : '']);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
              .finish({ outputSummary: '环境探测缓存命中' });
            return { ok: true, data: hit.value };
          }
          const list = cmds.map(c => `'${c}'`).join(',');
          const script = withVersion
            ? `$out = foreach ($c in ${list}) { $i = Get-Command $c -ErrorAction SilentlyContinue; if ($i) { $v = ''; try { $v = ((& $c --version) 2>&1 | Select-Object -First 1) } catch {}; "$($i.Name)|$($i.Source)|$v" } else { "$c||" } }; $out -join "\`n"`
            : `$out = foreach ($c in ${list}) { $i = Get-Command $c -ErrorAction SilentlyContinue; if ($i) { "$($i.Name)|$($i.Source)|" } else { "$c||" } }; $out -join "\`n"`;
          try {
            const r = await runPowershell(script, (withVersion ? 45 : 20) * 1000, tctx.sandboxRoot);
            const tools = r.stdout.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
              const [name, path, version] = l.split('|');
              return { name: (name || '').trim(), found: !!(path || '').trim(), path: (path || '').trim() || undefined, version: (version || '').trim() || undefined };
            });
            const data = { platform: process.platform, node: process.version, tools };
            tctx.cache.l2Set(key, data);
            return { ok: true, data };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      },
    });

    ctx.logger.info(`工具就绪: powershell_execute（只读 ${READONLY_EXE.size} 个 cmdlet + git/npm 子命令级细分，黑名单 ${DANGEROUS_PATTERNS.length} 类兜底）+ env_probe`);
  },
} satisfies Plugin;
