/**
 * server/routes/exec.ts —— 本机进程调用（git 与文件管理器）
 * 路由层唯一允许碰本机进程的地方：只有"在沙箱里读 git 状态"和"打开目录"两件事。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 在沙箱根目录执行 git 命令（无 repo 时返回 null） */
export async function gitIn(sandbox: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: sandbox, timeout: 15_000, windowsHide: true });
    return stdout;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 128 || code === 'ENOENT') return null; // 非 git 仓库 / git 未安装
    throw err;
  }
}

/** 用系统文件管理器打开目标（Windows: explorer） */
export function openInExplorer(target: string): void {
  const args = process.platform === 'win32' ? [`/select,${target}`] : [target];
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, args, { windowsHide: true }, (err) => {
    // explorer.exe 即使成功打开窗口也常以 exit code 1 结束；把 1 当失败会制造
    // “命令失败但目录其实已经打开”的假报错。只有真正的启动错误才记录。
    const benignWindowsExit = process.platform === 'win32' && !!err && (err as NodeJS.ErrnoException & { code?: number }).code === 1;
    if (err && !benignWindowsExit) console.warn(`[open] ${target} 失败:`, err.message);
  });
}
