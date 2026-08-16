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

/** 只读白名单（免审批）：首 token 大小写不敏感匹配；含完整路径时取文件名 */
const READONLY_WHITELIST = new Set([
  'get-childitem', 'get-item', 'get-content', 'get-process', 'get-service',
  'get-date', 'get-location', 'select-string', 'measure-object', 'where-object',
  'sort-object', 'ls', 'dir', 'cat', 'type', 'whoami', 'hostname', 'pwd', 'tree',
]);

/** 敏感文件模式（H10：白名单读命令触及密钥/内部数据也强制审批，堵住 Get-Content .env 免审批直读） */
const SENSITIVE_READ_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\.env\b/i, reason: '读取 .env 密钥文件' },
  { pattern: /\bagent\.db\b/i, reason: '读取内部数据库（含 provider 密钥明文）' },
];

/** 危险操作黑名单（第二道兜底：白名单命中但含危险词 → 仍需用户审批） */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(Remove-Item|Remove-ChildItem|Remove-ItemProperty|Remove-Variable)\b/i, reason: '删除文件/目录/属性' },
  { pattern: /(Set-Content|Add-Content|Clear-Content|Out-File|Copy-Item|Move-Item|Rename-Item)\b/i, reason: '写入/覆盖/移动文件' },
  { pattern: />{1,2}\s*\S/, reason: '重定向写文件' },
  { pattern: /(Format-Volume|format\s+[a-zA-Z]:)/i, reason: '格式化磁盘' },
  { pattern: /\b(Stop-Process|Stop-Service|taskkill)\b/i, reason: '终止进程/服务' },
  { pattern: /\b(Restart-Computer|Stop-Computer|shutdown|restart)\b/i, reason: '关机/重启' },
  { pattern: /\b(reg\s+(add|delete)|Set-ItemProperty|Remove-ItemProperty)\b/i, reason: '修改注册表' },
  { pattern: /\b(Invoke-WebRequest|Invoke-Expression|iex|Start-BitsTransfer|certutil|wget|curl)\b/i, reason: '下载/执行外部内容' },
  { pattern: /\b(diskpart|mountvol)\b/i, reason: '磁盘分区操作' },
  { pattern: /\b(Set-MpPreference|Set-MpThreatDefaultAction|sc\s+stop|net\s+stop)\b/i, reason: '停用安全防护/系统服务' },
  { pattern: /\b(Enable-PSRemoting|New-SelfSignedCertificate|Clear-EventLog)\b/i, reason: '高危系统操作' },
];

/** 取命令段的首 token：去调用运算符 &/引号，含完整路径时取文件名，统一小写 */
function firstTokenOf(segment: string): string {
  const raw = segment.trim().split(/\s+/)[0] ?? '';
  const cleaned = raw.replace(/^&/, '').replace(/^["']|["']$/g, '');
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return base.toLowerCase();
}

/** 白名单判定：整条命令按 | 和 ; 分段，每段首 token 都必须在只读白名单内 */
export function isReadOnlyCommand(command: string): boolean {
  return command
    .split(/[|;]/)
    .every((seg) => {
      const tok = firstTokenOf(seg);
      return tok !== '' && READONLY_WHITELIST.has(tok);
    });
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
          '2. 只读白名单命令（Get-ChildItem/Get-Content/Select-String 等，管道每段都是只读 cmdlet）免审批直接执行；其余任何命令（写入/删除/启动程序/下载等）都会弹出审批卡片，等待用户批准后自动执行；',
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
        limits: '命令超时 60s；非只读白名单命令需用户审批',
        output: '{stdout, stderr, exitCode}；exitCode=0 表示成功',
        description: '在 Windows 上执行 PowerShell 命令并返回输出（工作目录锚定沙箱根）。审批语义（白名单模型，默认需审批）：'
          + '仅当整条命令按 | 和 ; 分段后每段首 token 都是只读白名单命令（Get-ChildItem/Get-Item/Get-Content/Get-Process/Get-Service/Get-Date/Get-Location/'
          + 'Select-String/Measure-Object/Where-Object/Sort-Object/ls/dir/cat/type/whoami/hostname/pwd/tree）时免审批直接执行；'
          + '任一段非白名单、或命令含危险模式（删除/覆盖/重定向写/格式化/杀进程/关机/下载执行/注册表/Invoke-Expression 等）→ 拦截并请求用户审批，批准后自动执行。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'PowerShell 命令（一行或分号分隔）' },
            timeoutSec: { type: 'number', description: '超时秒数（默认 15，最大 60）' },
          },
          required: ['command'],
        },
        async handler(args: { command?: string; timeoutSec?: number }, tctx: ToolContext) {
          const command = String(args.command ?? '').trim();
          if (!command) return { ok: false, error: '命令不能为空' };
          const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 15, 1), 60);

          // C2/H1 白名单模型：全部分段只读 → 免审批；否则一律 needsApproval。
          // 黑名单兜底：白名单命中但含危险词（如 Invoke-Expression）仍需审批。
          // 敏感文件兜底：白名单读命令触及 .env/agent.db 也强制审批（防绕过文件工具读拒）。
          const { needsApproval, reason } = assessCommand(command);
          if (needsApproval && !tctx.approved) {
            // 请求用户审批（执行器级挂起，批准后自动重试）
            return {
              ok: false,
              needsApproval: true,
              approvalSummary: `PowerShell 命令需用户审批（${reason}）\n命令：${command.slice(0, 300)}`,
            };
          }
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

    ctx.logger.info(`工具就绪: powershell_execute（只读白名单 ${READONLY_WHITELIST.size} 项免审批，其余命令需用户审批；黑名单 ${DANGEROUS_PATTERNS.length} 类兜底）`);
  },
} satisfies Plugin;
