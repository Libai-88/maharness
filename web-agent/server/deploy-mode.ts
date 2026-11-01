/**
 * server/deploy-mode.ts —— 部署模式解析与启动安全自检（API-02）
 *
 * 三个显式模式（MAHARNESS_MODE，缺省 local）：
 * - local    本机单用户：只绑 127.0.0.1，Host/Origin 白名单，token 可选（现状行为）。
 * - trusted  本机受信：仍只绑回环，但**全部 /api 请求**（含 GET）强制 API token、
 *            审批强制一次性凭据——给「本机有不可信进程」的用户一个收紧开关。
 * - remote   远程单用户：绑定非回环地址，**必须**提供 TLS 证书与 API token，否则拒绝启动；
 *            插件仍在宿主进程执行（威胁模型 v1 的发布阻断项），remote 只解决传输与凭据层。
 *
 * 解析失败（配置非法/不完整）返回 ok:false —— startServer 据此 fail-closed 拒绝启动，
 * 不静默降级：错误配置必须让运维在启动日志里看见，而不是跑成一个“看起来能用的弱配置”。
 */

export type DeployMode = 'local' | 'trusted' | 'remote';

export interface DeployConfig {
  mode: DeployMode;
  /** 监听地址：local/trusted 固定回环；remote 取 MAHARNESS_BIND（默认 0.0.0.0） */
  bindHost: string;
  /** 全部 /api（含 GET/SSE）是否强制 API token */
  authRequired: boolean;
  /** 审批是否强制一次性凭据 */
  approvalEnforced: boolean;
  /** HTTPS 证书（remote 且已配置时启用，否则由反向代理终止 TLS） */
  tls?: { cert: string; key: string };
}

export type DeployResolveResult =
  | { ok: true; config: DeployConfig }
  | { ok: false; errors: string[] };

const MODES: readonly DeployMode[] = ['local', 'trusted', 'remote'];

function readTls(env: NodeJS.ProcessEnv): { cert?: string; key?: string; invalid: boolean } {
  const cert = env.MAHARNESS_TLS_CERT?.trim();
  const key = env.MAHARNESS_TLS_KEY?.trim();
  if (!cert && !key) return { invalid: false };
  if (!cert || !key) return { cert, key, invalid: true };
  return { cert, key, invalid: false };
}

/** 解析部署模式配置；任何不满足安全前置的组合都返回错误清单（不猜、不降级） */
export function resolveDeployMode(env: NodeJS.ProcessEnv = process.env): DeployResolveResult {
  const raw = (env.MAHARNESS_MODE ?? 'local').trim().toLowerCase();
  if (!MODES.includes(raw as DeployMode)) {
    return { ok: false, errors: [`MAHARNESS_MODE 无效值 "${raw}"（可选：local / trusted / remote）`] };
  }
  const mode = raw as DeployMode;
  const token = env.MAHARNESS_API_TOKEN?.trim() ?? '';
  const tls = readTls(env);
  const errors: string[] = [];

  if (mode === 'local') {
    if (env.MAHARNESS_BIND?.trim()) return { ok: false, errors: ['local 模式不允许设置 MAHARNESS_BIND（本机模式只绑回环）'] };
    return { ok: true, config: { mode, bindHost: '127.0.0.1', authRequired: false, approvalEnforced: false } };
  }

  if (mode === 'trusted') {
    if (!token) errors.push('trusted 模式必须设置 MAHARNESS_API_TOKEN（全 API 强制凭据，无 token 等于没收紧）');
    if (tls.cert || tls.key) errors.push('trusted 模式只绑回环，不需要 MAHARNESS_TLS_CERT/KEY（如需对外暴露请用 remote）');
    if (env.MAHARNESS_BIND?.trim()) return { ok: false, errors: ['trusted 模式不允许设置 MAHARNESS_BIND（本机模式只绑回环）'] };
    if (errors.length) return { ok: false, errors };
    return { ok: true, config: { mode, bindHost: '127.0.0.1', authRequired: true, approvalEnforced: true } };
  }

  // remote：对外暴露的最低安全线——TLS + token，一个都不能少
  if (!token) errors.push('remote 模式必须设置 MAHARNESS_API_TOKEN（对外暴露不允许免凭据）');
  if (tls.invalid) errors.push('MAHARNESS_TLS_CERT 与 MAHARNESS_TLS_KEY 必须成对提供');
  else if (!tls.cert) errors.push('remote 模式必须提供 TLS 证书（MAHARNESS_TLS_CERT + MAHARNESS_TLS_KEY）——明文 HTTP 不允许对外暴露');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      mode,
      bindHost: env.MAHARNESS_BIND?.trim() || '0.0.0.0',
      authRequired: true,
      approvalEnforced: true,
      tls: { cert: tls.cert!, key: tls.key! },
    },
  };
}

/** 请求级方法策略：trusted/remote 下 GET/SSE 也要 token（guard 的 GET 豁免只属 local） */
export function methodRequiresAuth(config: DeployConfig): boolean {
  if (!config.authRequired) return false;
  return true;
}

/** /api/security 展示用摘要（不含任何密钥材料） */
export function deployPosture(config: DeployConfig): { mode: DeployMode; bind: string; tls: boolean; apiAuthRequired: boolean; approvalEnforced: boolean } {
  return {
    mode: config.mode,
    bind: config.bindHost,
    tls: !!config.tls,
    apiAuthRequired: config.authRequired,
    approvalEnforced: config.approvalEnforced,
  };
}
