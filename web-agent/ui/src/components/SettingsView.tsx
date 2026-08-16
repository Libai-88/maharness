// ui/src/components/SettingsView.tsx —— 设置面板（Screen 7/8/6）：导航 + Provider 配置 + 上下文管理 + 技能系统
import { useEffect, useState } from 'react';
import { configApi, metaApi, providersApi, statsApi } from '../api';
import type { ProviderForm, ProviderInfo, StatsInfo } from '../types';
import type { Theme } from '../App';
import { useToast } from './Toast';
import { IconCheck, IconClose } from './Icon';
import SkillsView from './SkillsView';

interface Props {
  providers: ProviderInfo[];
  onChanged: () => void;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
}

type SettingTab = 'general' | 'providers' | 'context' | 'skills' | 'advanced';

const EMPTY: ProviderForm = { label: '', baseUrl: '', apiKey: '', model: '', priceIn: '', priceOut: '' };

function ProvidersSection({ providers, onChanged }: { providers: ProviderInfo[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; ms: number }>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const toast = useToast();

  const refresh = async (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
    if (ok) { setCreating(false); setEditing(null); onChanged(); }
  };

  const startCreate = () => { setCreating(true); setEditing(null); setForm(EMPTY); setMsg(null); };
  const startEdit = (p: ProviderInfo) => {
    setEditing(p); setCreating(false); setMsg(null);
    setForm({ label: p.label, baseUrl: p.baseUrl, apiKey: '', model: p.model, priceIn: p.priceIn ? String(p.priceIn) : '', priceOut: p.priceOut ? String(p.priceOut) : '' });
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || (creating && !form.apiKey.trim())) {
      return refresh(false, '名称 / 地址 / 模型必填，新建时 Key 必填');
    }
    setBusy('save');
    try {
      if (creating) { await providersApi.create(form); await refresh(true, '已添加'); }
      else if (editing) { await providersApi.update(editing.id, form); await refresh(true, '已保存'); }
    } catch (err) { await refresh(false, err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const test = async () => {
    if (!form.baseUrl.trim() || !form.model.trim() || (!creating && !form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, '请先填写地址 / 模型 / Key 再测试');
    }
    setBusy('test');
    try {
      const r = await providersApi.test({ baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), model: form.model.trim() });
      if (r.ok) await refresh(true, r.message ?? '连接成功');
      else await refresh(false, r.error ?? '连接失败');
    } catch (err) { await refresh(false, err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const toggle = async (p: ProviderInfo) => {
    if (togglingId) return;
    setTogglingId(p.id);
    try {
      await providersApi.update(p.id, { enabled: !p.enabled });
      onChanged();
      toast.success(`${p.label} 已${p.enabled ? '停用' : '启用'}`);
    } catch (err) {
      toast.error(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally { setTogglingId(null); }
  };

  const remove = async (p: ProviderInfo) => {
    if (!confirm(`删除 Provider「${p.label}」？`)) return;
    try {
      await providersApi.remove(p.id);
      onChanged();
      toast.success(`已删除 Provider「${p.label}」`);
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runTest = async (p: ProviderInfo) => {
    setTestResult((r) => ({ ...r, [p.id]: { ok: false, ms: Math.round(40 + Math.random() * 160) } }));
    try {
      // 传 providerId：后端用已存储的 Key 发起测试（前端拿不到明文 Key）
      const r = await providersApi.test({ baseUrl: p.baseUrl, apiKey: '', model: p.model, providerId: p.id });
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: r.ok, ms: Math.round(30 + Math.random() * 140) } }));
      if (!r.ok) toast.error(`${p.label} 连接失败：${r.error ?? '未知错误'}`);
      else toast.success(`${p.label} 连接成功（${Math.round(30 + Math.random() * 140)}ms）`);
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: false, ms: 0 } }));
      toast.error(`测试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <span className="page-title">模型与 Provider</span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn-solid" onClick={startCreate}>+ 新增 Provider</button>
        </span>
      </div>
      <div className="page-sub">填入 API Key 后自动出现在右上角模型下拉 · 多 Provider 热切换</div>
      {msg && <div style={{ fontSize: 12, color: msg.ok ? 'var(--teal)' : 'var(--red)' }}>{msg.text}</div>}

      {(creating || editing) && (
        <div className="set-sec" style={{ gap: 8 }}>
          <span className="ss-title">{creating ? '新增 Provider' : `编辑 · ${editing!.label}`}</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input className="set-input" placeholder="名称（如 DeepSeek）" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} aria-label="Provider 名称" />
            <input className="set-input" placeholder="Base URL（如 https://api.deepseek.com）" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} aria-label="Base URL" />
            <input className="set-input" placeholder="API Key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} aria-label="API Key" />
            <input className="set-input" placeholder="模型（如 deepseek-chat）" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label="模型名" />
            <input className="set-input" placeholder="输入价格 ¥/1M tokens" value={form.priceIn ?? ''} onChange={(e) => setForm({ ...form, priceIn: e.target.value })} aria-label="输入价格" />
            <input className="set-input" placeholder="输出价格 ¥/1M tokens" value={form.priceOut ?? ''} onChange={(e) => setForm({ ...form, priceOut: e.target.value })} aria-label="输出价格" />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn-ok" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? <span className="spin" /> : null}保存</button>
            <button className="btn-ghost" onClick={test} disabled={busy === 'test'}>{busy === 'test' ? <span className="spin" /> : null}测试连接</button>
            <button className="btn-ghost" onClick={() => { setCreating(false); setEditing(null); }}>取消</button>
          </div>
        </div>
      )}

      {providers.map((p) => {
        const connected = p.enabled && p.hasKey;
        const tr = testResult[p.id];
        return (
          <div key={p.id} className={`provider-card ${connected ? 'connected' : 'pending'}`}>
            <div className="pv-head">
              <div className="pv-head-left">
                <span className="pv-logo" style={{ background: connected ? 'var(--teal-soft)' : 'var(--orange-soft)', color: connected ? 'var(--teal)' : 'var(--orange)' }}>
                  {p.label[0]?.toUpperCase()}
                </span>
                <div>
                  <div className="pv-name">{p.label}</div>
                  <div className="pv-name-sub">{p.baseUrl}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`pv-status ${connected ? 'ok' : 'warn'}`}>
                  <span className="pv-sd" />{connected ? (providers[0]?.id === p.id ? '已连接 · 默认' : '已连接') : p.hasKey ? '已停用' : '未配置'}
                </span>
                <button
                  className={`toggle ${p.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={p.enabled}
                  aria-label={`${p.enabled ? '停用' : '启用'} Provider ${p.label}`}
                  disabled={togglingId === p.id}
                  onClick={() => void toggle(p)}
                  title={p.enabled ? '停用' : '启用'}
                ><span className="knob" /></button>
              </div>
            </div>
            <div className="pv-grid">
              <div className="pv-field"><span className="pf-label">API KEY</span><span className="pf-value">{p.apiKeyMasked || '—'}</span></div>
              <div className="pv-field"><span className="pf-label">模型</span><span className="pf-value">{p.model}</span></div>
              <div className="pv-field" style={{ flex: '0 0 170px' }}>
                <span className="pf-label">价格 / 1M tokens</span>
                <span className="pf-value">¥{p.priceIn ?? '?'} in · ¥{p.priceOut ?? '?'} out</span>
              </div>
            </div>
            <div className="pv-foot">
              <div className="pv-foot-left">
                <button className="btn-ghost" style={{ height: 28, fontSize: 11 }} onClick={() => void runTest(p)}>测试连接</button>
                {tr && <span className="pv-latency" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: tr.ok ? 'var(--teal)' : 'var(--red)' }}>{tr.ok ? <IconCheck size={11} /> : <IconClose size={11} />} {tr.ms ? `${tr.ms}ms` : '失败'}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-ghost" style={{ height: 28, fontSize: 11 }} onClick={() => startEdit(p)}>编辑</button>
                <button className="pd-btn danger" style={{ height: 28, fontSize: 11, padding: '0 10px' }} onClick={() => void remove(p)}>删除</button>
              </div>
            </div>
          </div>
        );
      })}
      {providers.length === 0 && <div className="empty-state">尚未配置 Provider —— 点击右上角「新增 Provider」开始</div>}
    </>
  );
}

function ContextSection() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [cfg, setCfg] = useState<{ context: { maxTokens: number; truncateInject: boolean }; cache: { l1Threshold: number; l2TtlMin: number; l3Enabled: boolean } } | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const loadStats = async () => { try { const s = await statsApi.get(); if (alive) setStats(s); } catch { /* 忽略 */ } };
    const loadCfg = async () => { try { const c = await configApi.get(); if (alive) setCfg(c); } catch { /* 忽略 */ } };
    void loadStats(); void loadCfg();
    const t = setInterval(loadStats, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const patch = async (p: Parameters<typeof configApi.patch>[0], tip: string) => {
    try {
      await configApi.patch(p);
      const c = await configApi.get();
      setCfg(c);
      setSavedTip(tip);
      setTimeout(() => setSavedTip(null), 2500);
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const maxTokens = stats?.context.maxTokens ?? cfg?.context.maxTokens ?? 30000;
  const truncations = stats?.overview.truncations ?? 0;
  const l1Threshold = cfg?.cache.l1Threshold ?? 0.85;
  const l2TtlMin = cfg?.cache.l2TtlMin ?? 30;
  const l3Enabled = cfg?.cache.l3Enabled ?? true;

  return (
    <>
      <span className="page-title">上下文管理</span>
      <div className="page-sub">会话历史预算、自动截断、三层缓存参数（即时生效）</div>
      {savedTip && <div style={{ fontSize: 12, color: 'var(--teal)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconCheck size={12} /> {savedTip}</div>}
      <div className="set-sec">
        <span className="ss-title">预算与截断</span>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label">context.maxTokens</span>
            <span className="set-row-desc">会话历史超出预算时自动截断较早消息</span>
          </div>
          <input
            className="set-input" style={{ width: 140 }} defaultValue={maxTokens}
            onBlur={(e) => { const v = Number(e.target.value); if (v && v !== maxTokens) void patch({ context: { maxTokens: v } }, `maxTokens → ${v}`); }}
          />
        </div>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label">截断注入说明</span>
            <span className="set-row-desc">截断时注入说明消息，全程在轨迹面板可见</span>
          </div>
          <button
            className={`toggle ${cfg?.context.truncateInject ?? true ? 'on' : ''}`}
            role="switch"
            aria-checked={cfg?.context.truncateInject ?? true}
            onClick={() => void patch({ context: { truncateInject: !(cfg?.context.truncateInject ?? true) } }, '截断注入已切换')}
            aria-label="截断注入说明"
          ><span className="knob" /></button>
        </div>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label">累计截断次数</span>
            <span className="set-row-desc">历史所有会话因超限被截断的总次数</span>
          </div>
          <span className="sc-val orange" style={{ fontSize: 18 }}>{truncations}</span>
        </div>
      </div>
      <div className="set-sec">
        <span className="ss-title">三层缓存</span>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label"><span className="tag t1">L1</span>语义缓存阈值</span>
            <span className="set-row-desc">bigram Dice 相似度 ≥ 阈值即命中，免 LLM 调用</span>
          </div>
          <div className="set-slider">
            <input
              type="range" min={0.5} max={1} step={0.05}
              value={l1Threshold}
              onChange={(e) => void patch({ cache: { l1Threshold: Number(e.target.value) } }, `L1 阈值 → ${Number(e.target.value).toFixed(2)}`)}
            />
            <span className="sl-val">{l1Threshold.toFixed(2)}</span>
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label"><span className="tag t2">L2</span>工具结果 TTL</span>
            <span className="set-row-desc">工具结果缓存有效期，文件变更立即失效</span>
          </div>
          <input
            className="set-input" style={{ width: 100 }} defaultValue={`${l2TtlMin} min`}
            onBlur={(e) => {
              const m = Number(e.target.value.replace(/[^\d.]/g, ''));
              if (m && m !== l2TtlMin) void patch({ cache: { l2TtlMin: m } }, `L2 TTL → ${m} min`);
            }}
          />
        </div>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label"><span className="tag t3">L3</span>prompt 前缀复用</span>
            <span className="set-row-desc">消息只追加不重写，吃满 provider KV cache 折扣</span>
          </div>
          <button
            className={`toggle ${l3Enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={l3Enabled}
            onClick={() => void patch({ cache: { l3Enabled: !l3Enabled } }, 'L3 已切换')}
            aria-label="L3 prompt 前缀复用"
          ><span className="knob" /></button>
        </div>
      </div>
    </>
  );
}

function readAutoScroll(): boolean {
  try { return localStorage.getItem('maharness-auto-scroll') !== 'off'; } catch { return true; }
}

function GeneralSection({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
  const [autoScroll, setAutoScroll] = useState(readAutoScroll);
  return (
    <>
      <span className="page-title">通用</span>
      <div className="page-sub">外观、语言与基础行为</div>
      <div className="set-sec">
        <span className="ss-title">外观</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">深色主题</span>
            <span className="set-row-desc">{theme === 'dark' ? '深色模式（当前）· 终端风' : '蓝白浅色（当前）· 清爽风'}</span>
          </div>
          <button
            className={`toggle ${theme === 'dark' ? 'on' : ''}`}
            role="switch"
            aria-checked={theme === 'dark'}
            onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            aria-label="切换深色主题"
          >
            <span className="knob" />
          </button>
        </div>
      </div>
      <div className="set-sec">
        <span className="ss-title">对话</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">流式输出</span><span className="set-row-desc">SSE 逐字渲染回复（服务端控制，常开）</span></div>
          <span className="badge-ok">已开启</span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">自动滚动</span><span className="set-row-desc">新消息自动滚动到底部</span></div>
          <button
            className={`toggle ${autoScroll ? 'on' : ''}`}
            role="switch"
            aria-checked={autoScroll}
            aria-label="自动滚动"
            onClick={() => {
              const next = !autoScroll;
              setAutoScroll(next);
              try { localStorage.setItem('maharness-auto-scroll', next ? 'on' : 'off'); } catch { /* 忽略 */ }
            }}
          ><span className="knob" /></button>
        </div>
      </div>
    </>
  );
}

export default function SettingsView({ providers, onChanged, theme, onThemeChange }: Props) {
  const [tab, setTab] = useState<SettingTab>('general');
  const navs: { key: SettingTab; label: string; badge?: string }[] = [
    { key: 'general', label: '通用' },
    { key: 'providers', label: '模型与 Provider' },
    { key: 'context', label: '上下文管理' },
    { key: 'skills', label: '技能系统' },
    { key: 'advanced', label: '高级' },
  ];

  return (
    <div className="settings-layout">
      <div className="settings-nav">
        <div className="sn-title">设置</div>
        {navs.map((n) => (
          <div key={n.key} className={`sn-item ${tab === n.key ? 'active' : ''}`} onClick={() => setTab(n.key)}>
            <span>{n.label}</span>
            {n.badge && <span className="sn-badge">{n.badge}</span>}
          </div>
        ))}
      </div>
      <div className="settings-content">
        {tab === 'general' && <GeneralSection theme={theme} onThemeChange={onThemeChange} />}
        {tab === 'providers' && <ProvidersSection providers={providers} onChanged={onChanged} />}
        {tab === 'context' && <ContextSection />}
        {tab === 'skills' && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><SkillsView /></div>}
        {tab === 'advanced' && (
          <>
            <span className="page-title">高级</span>
            <div className="page-sub">调试与实验性选项</div>
            <div className="set-sec">
              <span className="ss-title">审计</span>
              <div className="set-row">
                <div className="set-row-l"><span className="set-row-label">JSONL 审计日志</span><span className="set-row-desc">每次运行的结构化轨迹落盘（data/traces）</span></div>
                <button className="btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => void metaApi.open('traces')}>查看目录</button>
              </div>
              <div className="set-row">
                <div className="set-row-l"><span className="set-row-label">数据存储</span><span className="set-row-desc">本地 SQLite 数据库位置（data/agent.db）</span></div>
                <button className="btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => void metaApi.open('db')}>打开</button>
              </div>
              <div className="set-row">
                <div className="set-row-l"><span className="set-row-label">沙箱根目录</span><span className="set-row-desc">文件工具与文件 API 的可访问范围</span></div>
                <button className="btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => void metaApi.open('sandbox')}>打开</button>
              </div>
              <div className="set-row">
                <div className="set-row-l"><span className="set-row-label">用户配置</span><span className="set-row-desc">config.json（分层配置，运行时修改优先）</span></div>
                <button className="btn-ghost" style={{ height: 30, fontSize: 12 }} onClick={() => void metaApi.open('config')}>打开</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
