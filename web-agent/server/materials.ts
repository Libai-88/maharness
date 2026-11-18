import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { isDeniedReadPath, resolveInSandbox } from '../kernel/sandbox';
import type { Material, MaterialRef } from '../kernel/material';

export const MATERIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS materials_v1 (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS run_materials_v1 (run_id TEXT NOT NULL, material_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(run_id,material_id));
`;
export const MATERIAL_MAX_BYTES = 20 * 1024 * 1024;
export class MaterialError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
export class MaterialRepository {
  constructor(private readonly db: Database.Database) {}
  register(tenantId: string, workspace: string, path: string, projectRoot: string, id = randomUUID()): Material {
    const file = resolveInSandbox(workspace, path);
    if (isDeniedReadPath(file, workspace, projectRoot)) throw new MaterialError(403, 'MATERIAL_DENIED', '拒绝读取受保护路径');
    const info = statSync(file); if (!info.isFile() || info.size > MATERIAL_MAX_BYTES) throw new MaterialError(413, 'MATERIAL_TOO_LARGE', '仅支持不超过 20 MB 的普通文件');
    const bytes = readFileSync(file); const material: Material = { id, tenantId, workspace: resolve(workspace), path: relative(workspace, file), name: basename(file), format: extname(file).slice(1).toLowerCase(), size: bytes.length, version: createHash('sha256').update(bytes).digest('hex'), createdAt: Date.now() };
    this.db.prepare('INSERT INTO materials_v1 VALUES(?,?,?,?)').run(material.id, tenantId, material.workspace, JSON.stringify(material)); return material;
  }
  get(id: string, tenant: string, workspace: string): Material {
    const row = this.db.prepare('SELECT record FROM materials_v1 WHERE id=? AND tenant_id=? AND workspace=?').get(id, tenant, resolve(workspace)) as { record: string } | undefined;
    if (!row) throw new MaterialError(404, 'MATERIAL_NOT_FOUND', '文件不存在或不属于当前工作区');
    return JSON.parse(row.record);
  }
  sizeForTenant(ref: MaterialRef, tenant: string): number | undefined {
    const row = this.db.prepare('SELECT record FROM materials_v1 WHERE id=? AND tenant_id=?').get(ref.id, tenant) as { record: string } | undefined;
    if (!row) return undefined;
    const material = JSON.parse(row.record) as Material;
    return material.version === ref.version ? material.size : undefined;
  }
  resolve(ref: MaterialRef, tenant: string, workspace: string, projectRoot: string): { material: Material; file: string; bytes: Buffer } {
    const material = this.get(ref.id, tenant, workspace); const file = resolveInSandbox(workspace, material.path);
    if (isDeniedReadPath(file, workspace, projectRoot)) throw new MaterialError(403, 'MATERIAL_DENIED', '拒绝读取受保护路径');
    const info = statSync(file); if (!info.isFile() || info.size > MATERIAL_MAX_BYTES) throw new MaterialError(413, 'MATERIAL_TOO_LARGE', '文件不是普通文件或超过 20 MB');
    const bytes = readFileSync(file); const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.version || actual !== material.version) throw new MaterialError(409, 'FILE_VERSION_CONFLICT', '文件版本已变化，请重新选择文件');
    return { material, file, bytes };
  }
  validate(input: unknown, tenant: string, workspace: string, projectRoot: string): Material[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 10 || input.some(ref => !ref || typeof ref.id !== 'string' || !/^[a-f0-9]{64}$/.test(ref.version))) throw new MaterialError(400, 'INVALID_MATERIALS', '最多附加 10 个有效文件引用');
    if (new Set(input.map(ref => ref.id)).size !== input.length) throw new MaterialError(400, 'INVALID_MATERIALS', '不能重复附加相同文件');
    return input.map(ref => this.resolve(ref, tenant, workspace, projectRoot).material);
  }
  attach(runId: string, refs: MaterialRef[]): void { for (const ref of refs) this.db.prepare('INSERT INTO run_materials_v1 VALUES(?,?,?)').run(runId, ref.id, ref.version); }
}
