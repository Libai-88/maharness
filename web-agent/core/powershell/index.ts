/**
 * core/powershell/index.ts —— PowerShell 执行器插件（Windows 原生能力）
 * 安全机制（权限确认）：
 *  1. 危险命令检测：命中黑名单且未确认 → 拦截，需用户明确同意
 *  2. 确认后放行：confirm=true（由 LLM 仅在用户明确回复同意后携带）
 *  3. 超时自动杀进程树（默认 15s，上限 60s）
 *  4. 输出截断 8KB，UTF-8 编码，Trace 全程审计（命令/确认/输出）
 */
import { spawn } from 'node:child_process';
import type { Plugin, ToolContext } from '../../kernel/types';

/** 危险操作黑名单（宁拦勿放；命中后需用户确认才可执行） */
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

const MAX_OUTPUT = 8000;

interface PsResult { code: number; stdout: string; stderr: string }

/** 执行 PowerShell（UTF-8 输出、可超时、可杀进程树） */
function runPowershell(command: string, timeoutMs: number): Promise<PsResult> {
  return new Promise((resolve, reject) => {
    // OutputEncoding 保证 stdout 按 UTF-8 输出（Windows 控制台默认 GBK）
    const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; ${command}`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
      windowsHide: true,
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
          '2. 危险命令（删除/覆盖/格式化/杀进程/关机/下载执行/注册表修改等）会被安全机制拦截并弹出审批卡片，等待用户批准后自动执行；',
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
        description: '在 Windows 上执行 PowerShell 命令并返回输出。危险命令（删除/覆盖/格式化/杀进程/关机/下载执行等）会被安全机制拦截并请求用户审批，批准后自动执行。',
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

          const hit = DANGEROUS_PATTERNS.find((d) => d.pattern.test(command));
          if (hit && !tctx.approved) {
            // 请求用户审批（执行器级挂起，批准后自动重试）
            return {
              ok: false,
              needsApproval: true,
              approvalSummary: `PowerShell 危险命令（${hit.reason}）\n命令：${command.slice(0, 300)}`,
            };
          }
          if (hit && tctx.approved) {
            // 已获用户批准：审计留痕
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'system', name: '危险命令已获用户批准' })
              .finish({ outputSummary: `[${hit.reason}] ${command.slice(0, 300)}` });
          }

          try {
            const r = await runPowershell(command, timeoutSec * 1000);
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

    ctx.logger.info(`工具就绪: powershell_execute（危险命令 ${DANGEROUS_PATTERNS.length} 类需确认）`);
  },
} satisfies Plugin;
