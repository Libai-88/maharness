import { join } from 'node:path';
import { Kernel } from '../kernel/index.ts';

// 职责：正式回归支撑脚本——kernel/tests/plugin-trial.spec.ts 经 runPluginTrial
// 调用，属于 npm test 自动化覆盖，不是诊断脚本。

// stdout is reserved for the machine-readable trial result.
console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.warn = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.error = (...args) => process.stderr.write(`${args.join(' ')}\n`);

const root = process.argv[2];
if (!root) throw new Error('missing trial root');
const kernel = new Kernel(root, { sandboxRoot: root }, {
  dataDir: join(root, 'data'),
  userPluginsDir: join(root, 'plugins'),
  corePluginsDir: join(root, 'core'),
});
try {
  await kernel.plugins.loadAll();
  const id = process.env.MH_TRIAL_ID;
  const inst = id ? kernel.plugins.get(id) : undefined;
  const caps = inst ? kernel.plugins.capabilities('tool').map(() => 'tool') : [];
  const diagnostic = id ? kernel.plugins.diagnostics().find((d) => d.id === id) : undefined;
  process.stdout.write(JSON.stringify({
    ok: inst?.state === 'started', state: inst?.state ?? 'error',
    caps, error: inst?.error ?? diagnostic?.message ?? '插件试运行加载失败',
  }));
} finally {
  await kernel.stop();
}
