/**
 * MCP OAuth 2.1 授权码 + PKCE 客户端。
 *
 * 这是「本机手工完成」的流程：mcp_oauth_login 返回授权 URL，用户在浏览器完成授权后
 * 把回调 URL 中的 code 交给 mcp_oauth_complete。这样不需要在宿主里常驻一个公网回调
 * 端点，也不会把 client_secret 交给浏览器端。token 由插件私有存储保存。
 */
import { createHash, randomBytes } from 'node:crypto';

export interface OAuthAuthConfig {
  type: 'oauth';
  authorizationUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientIdEnv?: string;
  clientSecret?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  /** 必须与授权服务器登记的 redirect_uri 一致；默认本机回环。 */
  redirectUri?: string;
  /** RFC 8707 resource indicator（MCP server 端点）。 */
  resource?: string;
}

export interface OAuthTokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenUrl: string;
  clientId?: string;
  scopes?: string[];
  resource?: string;
}

export interface OAuthTokenStore {
  load(): OAuthTokenData | null;
  save(data: OAuthTokenData): void;
  clear(): void;
}

export interface OAuthStatus {
  state: 'authorized' | 'authorization-pending' | 'login-required';
  expiresAt?: number;
  redirectUri?: string;
}

export class OAuthLoginRequiredError extends Error {
  readonly code = 'OAUTH_LOGIN_REQUIRED';
  constructor(message = '需要先完成 MCP OAuth 登录（调用 mcp_oauth_login）') {
    super(message);
    this.name = 'OAuthLoginRequiredError';
  }
}

interface PendingAuthorization {
  verifier: string;
  state: string;
  redirectUri: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clientIdOf(cfg: OAuthAuthConfig, env: Record<string, string | undefined>): string | undefined {
  return cfg.clientId || (cfg.clientIdEnv ? env[cfg.clientIdEnv] : undefined);
}

function clientSecretOf(cfg: OAuthAuthConfig, env: Record<string, string | undefined>): string | undefined {
  return cfg.clientSecret || (cfg.clientSecretEnv ? env[cfg.clientSecretEnv] : undefined);
}

export class McpOAuthClient {
  private pending?: PendingAuthorization;
  private refreshing?: Promise<void>;

  constructor(
    private readonly name: string,
    private readonly cfg: OAuthAuthConfig,
    private readonly store: OAuthTokenStore,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly assertUrl: (url: string) => Promise<void> = async () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** 生成授权 URL；code_verifier 只留在进程内，不回传浏览器。 */
  async authorizationUrl(): Promise<{ url: string; state: string; redirectUri: string }> {
    const clientId = clientIdOf(this.cfg, this.env);
    if (!clientId) throw new Error(`MCP OAuth 缺少 clientId（${this.cfg.clientIdEnv ?? 'clientId'}）`);
    await this.assertUrl(this.cfg.authorizationUrl);
    const redirectUri = this.cfg.redirectUri ?? 'http://127.0.0.1:33418/callback';
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(24));
    this.pending = { verifier, state, redirectUri };

    const url = new URL(this.cfg.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (this.cfg.scopes?.length) url.searchParams.set('scope', this.cfg.scopes.join(' '));
    if (this.cfg.resource) url.searchParams.set('resource', this.cfg.resource);
    return { url: url.toString(), state, redirectUri };
  }

  /** 用回调 code 换 token。state 由调用方先校验（或直接传回调 URL）。 */
  async complete(code: string, state?: string): Promise<OAuthTokenData> {
    const pending = this.pending;
    if (!pending) throw new Error(`MCP OAuth 没有待完成的授权：${this.name}（请重新调用 mcp_oauth_login）`);
    if (state !== undefined && state !== pending.state) throw new Error('MCP OAuth state 不匹配，拒绝换取 token');
    const clientId = clientIdOf(this.cfg, this.env);
    if (!clientId) throw new Error(`MCP OAuth 缺少 clientId（${this.cfg.clientIdEnv ?? 'clientId'}）`);
    await this.assertUrl(this.cfg.tokenUrl);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
      ...(this.cfg.resource ? { resource: this.cfg.resource } : {}),
    });
    const secret = clientSecretOf(this.cfg, this.env);
    if (secret) form.set('client_secret', secret);
    const data = await this.tokenRequest(form);
    const token: OAuthTokenData = {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: this.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
      tokenUrl: this.cfg.tokenUrl,
      clientId,
      ...(this.cfg.scopes?.length ? { scopes: this.cfg.scopes } : {}),
      ...(this.cfg.resource ? { resource: this.cfg.resource } : {}),
    };
    this.store.save(token);
    this.pending = undefined;
    return token;
  }

  async getAccessToken(): Promise<string> {
    const token = this.store.load();
    if (token && token.expiresAt > this.now() + 60_000) return token.accessToken;
    if (token?.refreshToken) {
      await this.refresh(token);
      return this.store.load()?.accessToken ?? token.accessToken;
    }
    throw new OAuthLoginRequiredError(`MCP server ${this.name} 需要 OAuth 登录（调用 mcp_oauth_login）`);
  }

  /** 清除本地 token 与待完成授权；服务端吊销由用户另行在授权方完成。 */
  logout(): void {
    this.store.clear();
    this.pending = undefined;
  }

  private async refresh(current: OAuthTokenData): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!current.refreshToken) throw new OAuthLoginRequiredError(`MCP server ${this.name} 的 refresh token 不存在`);
      await this.assertUrl(current.tokenUrl);
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: current.clientId ?? clientIdOf(this.cfg, this.env) ?? '',
        ...(current.resource ? { resource: current.resource } : {}),
      });
      const secret = clientSecretOf(this.cfg, this.env);
      if (secret) form.set('client_secret', secret);
      const data = await this.tokenRequest(form);
      this.store.save({
        ...current,
        accessToken: data.access_token,
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        expiresAt: this.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
      });
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** 401 时强制刷新一次（即使本地判断 token 未过期）。 */
  async refreshNow(): Promise<void> {
    const token = this.store.load();
    if (!token?.refreshToken) throw new OAuthLoginRequiredError(`MCP server ${this.name} 的令牌已失效，请重新登录`);
    await this.refresh(token);
  }

  status(): OAuthStatus {
    const token = this.store.load();
    if (token && token.expiresAt > this.now()) return { state: 'authorized', expiresAt: token.expiresAt };
    if (this.pending) return { state: 'authorization-pending', redirectUri: this.pending.redirectUri };
    return { state: 'login-required' };
  }

  private async tokenRequest(form: URLSearchParams): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`MCP OAuth token 端点 HTTP ${res.status}`);
    const data = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('MCP OAuth token 响应缺少 access_token');
    return {
      access_token: data.access_token,
      ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
      ...(typeof data.expires_in === 'number' ? { expires_in: data.expires_in } : {}),
    };
  }
}
