/**
 * server/secrets.ts —— API key 加密存储（AES-256-GCM）
 * 现状问题：providers.api_key 明文落 SQLite，备份/文件读取即泄露凭据。
 * 方案：数据目录下 secret.key 主密钥（首启生成 32 字节随机）；
 * 存储格式 `v1:<iv>:<tag>:<ct>`（Base64），密文外置 IV/TAG，非对称不可推导。
 *
 * A7 收口（三条）：
 *  1. **Windows 权限**：`chmodSync(0o600)` 在 Windows 上只切「只读位」，不写 DACL，
 *     因此不构成权限收紧。改为尽力调用 `icacls /inheritance:r /grant:r <当前用户>:F`
 *     重建显式 DACL（只授当前用户 FULL）。失败只 warn、不阻断启动——本机个人服务
 *     不能因为安全加固失败而拒绝启动。**语义限制必须讲清**：文件归当前用户所有，
 *     以同一用户身份运行的任何进程仍可读它；icacls 挡的是「其他账户 / 标准用户」
 *     与只读备份遍历，挡不住同权限恶意进程（那属于 A6 威胁模型的同一条边界）。
 *  2. **解密失败不再静默**：由 Store 记录「该 provider 密钥不可解」并经 API 暴露
 *     （见 db.ts 的 keyBroken / keyStatus()）。本文件只负责把主密钥的来历状态说清楚。
 *  3. **不静默重新生成密钥**：secret.key 丢失/异常且 DB 里已有 `v1:` 密文时，
 *     重新生成会让全部旧密文永久作废。策略（取舍说明）：
 *       - 密钥文件**不存在** + 有旧密文 → 仍然生成新密钥（否则整个服务不可用、
 *         新配置的 key 也无从加密），但状态记为 `created-with-ciphertext`，
 *         由调用方打 ERROR 级告警 + provider 侧 keyBroken 暴露：旧密文确实作废，
 *         用户必须重新录入 key。不选「启动失败」：本机个人服务被一次密钥文件
 *         丢失钉死，代价大于收益，且用户往往没有备份。
 *       - 密钥文件**存在但解析异常** + 有旧密文 → **拒绝覆盖**（保留原始字节，
 *         异常多半是截断/BOM/权限导致的读取失败，是可修复的），本次不返回密钥
 *         （Store 走「无主密钥」模式：密文不解密、全部标记不可解、新写入退回明文兜底
 *         并告警）。要强制重建须显式 `MAHARNESS_ALLOW_SECRET_KEY_RESET=1`，此时先把
 *         原文件另存为 `secret.key.malformed-<时间戳>` 再重建——绝不静默丢弃任何可取证字节。
 *       - 无旧密文（首启/纯明文库）→ 与历史行为一致：直接生成落盘。
 * 密钥文件丢失 = 已存 key 不可解密（本机个人服务可接受的取舍，但要显式告知）。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import * as os from 'node:os';

export const SECRET_PREFIX = 'v1:';
const KEY_FILE = 'secret.key';

/** 主密钥来历状态（供启动日志、/api/security 与 Store 的 keyBroken 口径共用） */
export type SecretKeyState =
  /** 复用既有有效密钥 */
  | 'ok'
  /** 首次启动：无密钥文件、库内也无密文 → 正常生成 */
  | 'created'
  /** 密钥文件缺失但库里已有密文 → 生成了新密钥，旧密文不可解（必须告警） */
  | 'created-with-ciphertext'
  /** 密钥文件异常（长度/格式不对）但库里已有密文 → 拒绝覆盖，本次无密钥 */
  | 'malformed-preserved'
  /** 密钥文件异常但库里无密文 → 备份原文件后重建 */
  | 'malformed-reset'
  /** 密钥文件不可读/不可写（数据目录权限问题） */
  | 'unavailable';

export interface SecretKeyInfo {
  /** 主密钥；undefined = 本次运行没有可用主密钥（不猜测、不覆盖旧文件） */
  key?: Buffer;
  state: SecretKeyState;
  /** secret.key 路径（供日志/状态接口指路） */
  path: string;
  /** 异常文件被另存到哪里（仅 malformed-reset 场景） */
  backupPath?: string;
  /** 中文说明：可直接进日志与状态接口 */
  message: string;
}

/**
 * Windows DACL 收紧（A7-1）。`MAHARNESS_SECRET_KEY_ACL=0` 可关闭（排障/CI）。
 * 语义边界见文件头注释：挡其他账户与只读遍历，挡不住同权限进程。
 * 非 Windows 走 chmod(0600)——那里它是真的生效的 POSIX 权限位。
 */
export function hardenSecretKeyPath(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch { /* Windows 上语义有限；POSIX 上失败说明文件系统不支持权限位：交由 icacls 分支/忽略 */ }
  if (process.platform !== 'win32') return;
  if (process.env.MAHARNESS_SECRET_KEY_ACL === '0') return;
  try {
    // trustee 取当前登录账户；DOMAIN\User 形式最稳（避免同名本地账户歧义导致 icacls 报错）
    const user = process.env.USERNAME ?? os.userInfo().username;
    const domain = process.env.USERDOMAIN;
    const trustee = domain && !user.includes('\\') ? `${domain}\\${user}` : user;
    const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${trustee}:F`], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (r.error) {
      console.warn('[secret] icacls 不可用（Windows 权限未收紧；chmod 在该平台只切只读位）:',
        r.error.message);
    } else if (r.status !== 0) {
      console.warn(`[secret] icacls 收紧 secret.key 权限失败（status=${r.status}，不阻断启动）:`,
        String(r.stderr || r.stdout || '').trim().slice(0, 200));
    }
  } catch (err) {
    console.warn('[secret] icacls 调用异常（不阻断启动）:', err instanceof Error ? err.message : String(err));
  }
}

/** 读密钥文件：返回合法 Buffer，或 null（不存在/异常）；读取异常与「不存在」分开报告 */
function readKeyFile(path: string): { key?: Buffer; problem?: string } {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const buf = Buffer.from(raw, 'hex');
    // 期望：64 位 hex（32 字节）。长度/字符集不符即视为异常文件。
    if (buf.length === 32 && /^[0-9a-fA-F]{64}$/.test(raw)) return { key: buf };
    return { problem: `内容不是 32 字节十六进制（长度 ${raw.length}）` };
  } catch (err) {
    return { problem: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

function generateAndPersist(dataDir: string, path: string): { key?: Buffer; state: 'created' | 'unavailable'; message: string } {
  const key = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, key.toString('hex'), { encoding: 'utf-8', flag: 'w' });
    hardenSecretKeyPath(path);
    return { key, state: 'created', message: '已生成新的主密钥' };
  } catch (err) {
    // 落盘失败：进程内用随机密钥继续（新写入的密文重启后不可解，必须告警）
    console.warn('[secret] 写入 secret.key 失败（本次生成的密钥不会持久，重启即失效）:',
      err instanceof Error ? err.message : String(err));
    return { key, state: 'unavailable', message: `密钥文件写入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 主密钥解析（A7-3 的策略入口）。
 * @param opts.hasExistingCiphertext 延迟判定「库里是否已有 v1: 密文」——只在密钥
 *   缺失/异常的分支才调用（正常首启/复用路径不碰数据库，零额外开销）。
 */
export function resolveSecretKey(dataDir: string, opts: { hasExistingCiphertext?: () => boolean } = {}): SecretKeyInfo {
  const path = join(dataDir, KEY_FILE);
  const allowReset = process.env.MAHARNESS_ALLOW_SECRET_KEY_RESET === '1';
  const hasCipher = () => { try { return !!opts.hasExistingCiphertext?.(); } catch { return false; } };

  const read = readKeyFile(path);
  if (read.key) {
    // 既有密钥文件也走一次收紧：老版本只用 chmod（Windows 上不设 DACL），
    // 不补这一步的话「已经存在的 secret.key」永远得不到 icacls 修复。
    hardenSecretKeyPath(path);
    return { key: read.key, state: 'ok', path, message: '复用既有主密钥' };
  }

  // 密钥文件不存在
  if (!read.problem) {
    if (hasCipher()) {
      const r = generateAndPersist(dataDir, path);
      return {
        ...r,
        path,
        // 状态必须如实标注：这条路径上旧密文全部作废，是「用户必须知道」的故障，
        // 不能伪装成普通首启 created（调用方按 state 决定 log 级别）
        state: r.state === 'unavailable' ? 'unavailable' : 'created-with-ciphertext',
        message: 'secret.key 缺失但数据库中已有密文：已生成新密钥，旧密文全部不可解，'
          + '请在设置页重新录入各供应商密钥（或从备份恢复原 secret.key 后重启）',
      };
    }
    const r = generateAndPersist(dataDir, path);
    return { ...r, path, message: r.state === 'created' ? '首次启动：已生成主密钥' : r.message };
  }

  // 密钥文件存在但异常
  if (!hasCipher()) {
    // 库里没有密文 = 没有会作废的东西；仍留一份取证备份再重建
    let backupPath: string | undefined;
    try {
      backupPath = `${path}.malformed-${Date.now()}`;
      copyFileSync(path, backupPath);
      chmodSync(backupPath, 0o600);
    } catch (err) {
      console.warn('[secret] 异常密钥文件备份失败（继续重建）:', err instanceof Error ? err.message : String(err));
      backupPath = undefined;
    }
    const r = generateAndPersist(dataDir, path);
    return {
      ...r, backupPath, path,
      state: r.state === 'unavailable' ? 'unavailable' : 'malformed-reset',
      message: `secret.key ${read.problem}；库内无密文，已重建${backupPath ? `（原文件另存为 ${basename(backupPath)}）` : ''}`,
    };
  }
  if (allowReset) {
    let backupPath: string | undefined;
    try {
      backupPath = `${path}.malformed-${Date.now()}`;
      copyFileSync(path, backupPath);
    } catch (err) {
      console.warn('[secret] 异常密钥文件备份失败（仍按要求重建）:', err instanceof Error ? err.message : String(err));
    }
    const r = generateAndPersist(dataDir, path);
    return {
      ...r, backupPath, path,
      state: r.state === 'unavailable' ? 'unavailable' : 'malformed-reset',
      message: `secret.key ${read.problem}；已按要求（MAHARNESS_ALLOW_SECRET_KEY_RESET=1）重建密钥，`
        + '库内旧密文不可解，需重新录入供应商密钥',
    };
  }
  // 拒绝覆盖：不写文件、不返回密钥
  return {
    state: 'malformed-preserved',
    path,
    message: `secret.key ${read.problem}，且数据库中已有密文：已拒绝重新生成（避免旧密文静默作废）。`
      + '请人工修复/移除该文件后重启；确要重建请设 MAHARNESS_ALLOW_SECRET_KEY_RESET=1（会先备份原文件）',
  };
}

/**
 * 读取或创建主密钥（32 字节）。
 * 兼容旧签名：只关心密钥的调用方仍拿 Buffer；拿不到密钥时返回 undefined
 * （= 本次运行没有可用主密钥，Store 走无密钥模式并标记 keyBroken）。
 * 需要知道来历（告警/状态接口）请用 resolveSecretKey()。
 */
export function loadOrCreateSecretKey(dataDir: string, opts: { hasExistingCiphertext?: () => boolean } = {}): Buffer | undefined {
  return resolveSecretKey(dataDir, opts).key;
}

/** 加密：`v1:base64(iv):base64(tag):base64(ct)` */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** 解密；格式非法/密钥不符（GCM auth 失败）时抛错 */
export function decryptSecret(blob: string, key: Buffer): string {
  if (!blob.startsWith(SECRET_PREFIX)) return blob;
  const parts = blob.slice(SECRET_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('凭据密文格式非法');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 从任意来源（env 变量等）生成确定密钥：仅用于无 secret.key 场景的兜底散列 */
export function deriveKeyFrom(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

export function isEncrypted(blob: string): boolean {
  return blob.startsWith(SECRET_PREFIX);
}
