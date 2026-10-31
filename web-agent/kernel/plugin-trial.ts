import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export interface PluginTrialInput {
  id: string;
  manifest: Record<string, unknown>;
  source: string;
  timeoutMs?: number;
}

export interface PluginTrialResult {
  ok: boolean;
  state?: string;
  caps?: string[];
  error?: string;
}

/** 在临时项目根和独立 Node 进程中启动一次插件，结束后删除全部试运行文件。 */
export async function runPluginTrial(input: PluginTrialInput): Promise<PluginTrialResult> {
  const root = await mkdtemp(join(projectRoot, '.plugin-trial-'));
  const plugins = join(root, 'plugins');
  const core = join(root, 'core');
  const pluginDir = join(plugins, input.id);
  try {
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(core, { recursive: true });
    symlinkSync(join(projectRoot, 'kernel'), join(root, 'kernel'), 'junction');
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ ...input.manifest, enabled: true }, null, 2), 'utf8');
    writeFileSync(join(pluginDir, 'index.ts'), input.source, 'utf8');
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx', join(projectRoot, 'scripts', 'plugin-trial-runner.mjs'), root,
    ], { cwd: projectRoot, timeout: input.timeoutMs ?? 5_000, windowsHide: true, maxBuffer: 256 * 1024,
      env: { ...process.env, MH_TRIAL_ID: input.id } });
    return JSON.parse(stdout.trim()) as PluginTrialResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 子进程退出后再由系统清理 */ }
  }
}
