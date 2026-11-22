import { join } from 'node:path';
import { backupTenantWorkspace, listTenantBackups, restoreTenantWorkspace } from '../server/tenant-backup';
import { tenantSandboxPath } from '../server/tenant-workspace';

const root = process.cwd();
const dataDir = process.env.AGENT_DATA_DIR || join(root, 'data');
const base = process.env.SANDBOX_ROOT || root;
const command = process.argv[2] ?? 'list';
const args = process.argv.slice(3);

function flagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (command === 'backup') {
  const tenantId = flagValue('--tenant');
  if (!tenantId) {
    console.error('用法: tenant-workspace backup --tenant <id>');
    process.exit(2);
  }
  const result = backupTenantWorkspace({ base, dataDir, tenantId });
  console.log(JSON.stringify({ ok: true, dir: result.dir, manifest: result.manifest }, null, 2));
} else if (command === 'restore') {
  const backupDir = flagValue('--backup');
  if (!backupDir) {
    console.error('用法: tenant-workspace restore --backup <dir> [--tenant <id>]');
    process.exit(2);
  }
  const result = restoreTenantWorkspace({ base, dataDir, backupDir, tenantId: flagValue('--tenant') });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} else if (command === 'path') {
  const tenantId = flagValue('--tenant') ?? 'default';
  console.log(tenantSandboxPath(base, tenantId));
} else if (command === 'list') {
  console.log(JSON.stringify(listTenantBackups(dataDir), null, 2));
} else {
  console.error('用法: tenant-workspace backup|restore|list|path');
  process.exit(2);
}
