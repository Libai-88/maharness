// ui/src/components/SettingsView.tsx —— 设置面板（Screen 7/8/6）：导航 + Provider 配置 + 上下文管理 + 技能系统
import { useEffect, useState } from 'react';
import { configApi, metaApi, providersApi, rulesApi, statsApi } from '../api';
import type { RulesView, RuntimeConfig } from '../api';
import type { ProviderForm, ProviderInfo, PulledModel, StatsInfo } from '../types';
import type { Brand, Theme } from '../App';
import { toast } from 'sonner';
import { IconCheck, IconClose } from './Icon';
import Confirm, { type ConfirmRequest } from './Confirm';
import SkillsView from './SkillsView';

interface Props {
  providers: ProviderInfo[];
  onChanged: () => void;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  brand: Brand;
  onBrandChange: (b: Brand) => void;
}

type SettingTab = 'general' | 'providers' | 'context' | 'routing' | 'rules' | 'skills' | 'advanced';

const EMPTY: ProviderForm = { label: '', baseUrl: '', apiKey: '', model: '', protocol: 'openai', priceIn: '', priceOut: '' };

function ProvidersSection({ providers, onChanged }: { providers: ProviderInfo[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [busy, setBusy] = useState<'save' | 'test' | 'pull' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; ms: number }>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 删除 Provider 的二步确认走应用内弹层（原生 confirm 在这套界面里最出戏）
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  // 拉取到的模型列表（datalist 供「模型」输入框下拉选择；切换新建/编辑时重置）
  const [models, setModels] = useState<PulledModel[]>([]);

  const refresh = async (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
    if (ok) { setCreating(false); setEditing(null); onChanged(); }
  };

  const startCreate = () => { setCreating(true); setEditing(null); setForm(EMPTY); setMsg(null); setModels([]); };
  const startEdit = (p: ProviderInfo) => {
    setEditing(p); setCreating(false); setMsg(null); setModels([]);
    setForm({ label: p.label, baseUrl: p.baseUrl, apiKey: '', model: p.model, protocol: p.protocol ?? 'openai', priceIn: p.priceIn ? String(p.priceIn) : '', priceOut: p.priceOut ? String(p.priceOut) : '' });
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || (creating && !form.apiKey.trim())) {
      return refresh(false, '名称 / 地址 / 模型必填，新建时 Key 必填');
    }
    setBusy('save');
    let savedId: string | null = null;
    try {
      if (creating) { const p = await providersApi.create(form); savedId = p.id; await refresh(true, '已添加'); }
      else if (editing) { await providersApi.update(editing.id, form); savedId = editing.id; await refresh(true, '已保存'); }
      else { return; }
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
      setBusy(null);
      return;
    }
    setBusy(null);
    // 保存（尤其是换 key）后立即验证：一次测试请求确认恢复，不等下一条真实消息
    if (savedId) await verifyKey(savedId, form.baseUrl.trim(), form.model.trim(), form.protocol);
  };

  const test = async () => {
    if (!form.baseUrl.trim() || !form.model.trim() || (!creating && !form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, '请先填写地址 / 模型 / Key 再测试');
    }
    setBusy('test');
    try {
      const r = await providersApi.test({
        baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), model: form.model.trim(),
        protocol: form.protocol, ...(editing ? { providerId: editing.id } : {}),
      });
      if (r.ok) await refresh(true, r.message ?? `连接成功（${r.latencyMs ?? 0}ms）`);
      else await refresh(false, r.error ?? '连接失败');
    } catch (err) { await refresh(false, err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const pullModels = async () => {
    if (!form.baseUrl.trim() || (!form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, '请先填写 Base URL 与 Key（编辑已保存 Provider 时 Key 可留空）');
    }
    setBusy('pull');
    try {
      // 编辑时传 providerId：后端用已存储的 Key 拉取（前端拿不到明文 Key）
      const r = await providersApi.fetchModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        protocol: form.protocol,
        ...(editing ? { providerId: editing.id } : {}),
      });
      const list = r.models ?? [];
      setModels(list);
      // 选中即免手填：模型名 + 价格一并带入表单
      setForm((f) => {
        const pick = list.find(m => m.id === f.model.trim()) ?? list[0];
        if (!pick) return f;
        return {
          ...f,
          model: pick.id,
          priceIn: f.priceIn?.trim() ? f.priceIn : String(pick.priceIn ?? ''),
          priceOut: f.priceOut?.trim() ? f.priceOut : String(pick.priceOut ?? ''),
        };
      });
      const vision = list.filter(m => m.vision).length;
      setMsg({ ok: true, text: `已拉取 ${list.length} 个模型（其中 ${vision} 个支持视觉）——选择模型即自动带入能力与价格` });
      setTimeout(() => setMsg(null), 6000);
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const toggle = async (p: ProviderInfo) => {
    if (togglingId) return;
    setTogglingId(p.id);
    try {
      await providersApi.update(p.id, { enabled: !p.enabled });
      onChanged();
      toast.success(`「${p.label}」已${p.enabled ? '先歇着' : '开始干活'}`);
    } catch (err) {
      toast.error(`「${p.label}」没切换成功：${err instanceof Error ? err.message : String(err)}`);
    } finally { setTogglingId(null); }
  };

  const remove = async (p: ProviderInfo) => {
    // 二步确认：应用内弹层（原生 confirm 会弹出系统对话框，与手账界面完全两个世界）
    setConfirmReq({
      text: `删除 Provider「${p.label}」？这把钥匙的配置会一起删掉。`,
      okText: '删除',
      danger: true,
      onOk: () => {
        void (async () => {
          try {
            await providersApi.remove(p.id);
            onChanged();
            toast.success(`「${p.label}」已经删掉了`);
          } catch (err) {
            toast.error(`没删掉：${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      },
    });
  };

  /** 验证密钥（用已存储的 Key 发一次测试请求）：结果联动 provider 健康——
   *  成功清除 authFailed 红标与会话横幅；失败标记失效。 */
  const verifyKey = async (id: string, base: string, model: string, protocol?: string) => {
    setTestResult((r) => ({ ...r, [id]: { ok: false, ms: 0 } }));
    try {
      const r = await providersApi.test({ baseUrl: base, apiKey: '', model, protocol, providerId: id });
      setTestResult((prev) => ({ ...prev, [id]: { ok: r.ok, ms: r.latencyMs ?? 0 } }));
      if (r.ok) setMsg({ ok: true, text: `钥匙可用（往返 ${r.latencyMs ?? 0}ms）——这条线路已恢复` });
      else setMsg({ ok: false, text: `钥匙没通过：${r.error ?? '连不上'}${r.authFailed ? '（密钥无效，检查后重新保存）' : ''}` });
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, ms: 0 } }));
      setMsg({ ok: false, text: `验证没做成：${err instanceof Error ? err.message : String(err)}` });
    }
    setTimeout(() => setMsg(null), 6000);
    // 健康状态已变（清除/标记）——刷新列表让红标即时生效
    onChanged();
  };

  const runTest = async (p: ProviderInfo) => {
    setTestResult((r) => ({ ...r, [p.id]: { ok: false, ms: 0 } }));
    try {
      // 传 providerId：后端用已存储的 Key 发起测试（前端拿不到明文 Key），
      // 结果联动健康状态（成功恢复红标消失 / 失败标记失效）
      const r = await providersApi.test({ baseUrl: p.baseUrl, apiKey: '', model: p.model, protocol: p.protocol, providerId: p.id });
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: r.ok, ms: r.latencyMs ?? 0 } }));
      if (!r.ok) toast.error(`「${p.label}」没连上：${r.error ?? '说不清原因'}${r.authFailed ? '（这把钥匙无效）' : ''}`);
      else toast.success(`「${p.label}」钥匙可用（往返 ${r.latencyMs ?? 0}ms）`);
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: false, ms: 0 } }));
      toast.error(`验证没做成：${err instanceof Error ? err.message : String(err)}`);
    }
    // 红标即时更新（后端已联动健康状态）
    onChanged();
  };

  return (
    <>
      <Confirm req={confirmReq} onClose={() => setConfirmReq(null)} />
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
            <select className="set-input" value={form.protocol ?? 'openai'} onChange={(e) => setForm({ ...form, protocol: e.target.value })} aria-label="协议类型">
              <option value="openai">OpenAI 兼容（多数网关/国产）</option>
              <option value="anthropic">Anthropic 原生</option>
              <option value="ollama">Ollama 本地</option>
            </select>
            <input className="set-input" placeholder="模型（可拉取列表直接点选）" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label="模型名" list="provider-model-options" />
            <datalist id="provider-model-options">
              {models.map((m) => <option key={m.id} value={m.id} />)}
            </datalist>
            <input className="set-input" placeholder="输入价格 /1M tokens（拉取后自动填）" value={form.priceIn ?? ''} onChange={(e) => setForm({ ...form, priceIn: e.target.value })} aria-label="输入价格" />
            <input className="set-input" placeholder="输出价格 /1M tokens（拉取后自动填）" value={form.priceOut ?? ''} onChange={(e) => setForm({ ...form, priceOut: e.target.value })} aria-label="输出价格" />
          </div>
          {models.length > 0 && (
            <div className="pv-model-list" role="listbox" aria-label="拉取到的模型">
              {models.slice(0, 60).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`pv-model${form.model === m.id ? ' on' : ''}`}
                  onClick={() => setForm({
                    ...form, model: m.id,
                    priceIn: form.priceIn?.trim() ? form.priceIn : String(m.priceIn ?? ''),
                    priceOut: form.priceOut?.trim() ? form.priceOut : String(m.priceOut ?? ''),
                  })}
                  title={`上下文 ${m.contextWindow} · 最大输出 ${m.maxOutput} · $${m.priceIn}/$${m.priceOut} per 1M${m.source === 'pulled' ? '（供应商返回）' : '（按模型名推断）'}`}
                >
                  <span className="pvm-id">{m.id}</span>
                  <span className="pvm-caps">
                    {m.vision && <span className="pvm-cap vis">视觉</span>}
                    {m.tools && <span className="pvm-cap">工具</span>}
                    {m.reasoning && <span className="pvm-cap">推理</span>}
                    <span className="pvm-cap ctx">{m.contextWindow >= 1_000_000 ? `${Math.round(m.contextWindow / 1_000_000)}M` : `${Math.round(m.contextWindow / 1000)}k`}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn-ok" onClick={save} disabled={busy !== null}>{busy === 'save' ? <span className="spin" /> : null}保存</button>
            <button className="btn-ghost" onClick={() => void pullModels()} disabled={busy !== null}>{busy === 'pull' ? <span className="spin" /> : null}拉取模型列表</button>
            <button className="btn-ghost" onClick={test} disabled={busy !== null}>{busy === 'test' ? <span className="spin" /> : null}测试连接</button>
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
                {p.health?.authFailed && (
                  <span className="pv-auth-bad" title={p.health.lastError}>密钥失效</span>
                )}
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
              <div className="pv-field" style={{ flex: '0 0 200px' }}>
                <span className="pf-label">协议 / 能力</span>
                <span className="pf-value pv-caps-inline">
                  {p.protocol ?? 'openai'}
                  {(p.models?.length ?? 0) > 0 && <span className="pvm-cap">{p.models!.length} 模型</span>}
                  {(p.models ?? []).some((m) => !!m.vision) && <span className="pvm-cap vis">视觉</span>}
                </span>
              </div>
            </div>
            <div className="pv-foot">
              <div className="pv-foot-left">
                <button className="btn-ghost" style={{ height: 28, fontSize: 11 }} onClick={() => void runTest(p)} title="用已存储的 Key 发一次测试请求——验证密钥有效性并恢复健康状态">验证密钥</button>
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
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);

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
      toast.error(`这项设置没保存上：${err instanceof Error ? err.message : String(err)}`);
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

/** 模型路由：任务类型 → provider@model（下拉选目标，含能力标注，不再手改 config.json） */
function RoutingSection() {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  const load = async () => { try { setCfg(await configApi.get()); } catch { /* 忽略 */ } };
  useEffect(() => { void load(); }, []);

  const commit = async (routing: Record<string, string>) => {
    try {
      await configApi.patch({ agent: { modelRouting: routing } });
      await load();
      setTip('路由规则已保存并热生效');
      setTimeout(() => setTip(null), 2500);
    } catch (err) {
      toast.error(`路由规则没保存上：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const routing = cfg?.agent.modelRouting ?? {};
  const types = cfg?.taskTypes ?? ['默认', '代码', '文件操作', '检索', '写作', '问答', '其他'];
  const targets = cfg?.routingTargets ?? [];
  const used = Object.keys(routing).filter(k => !types.includes(k));

  return (
    <>
      <span className="page-title">模型路由</span>
      <div className="page-sub">按任务类型把整轮对话路由到指定模型；能力不符时（如需要视觉）harness 会自动借道多模态模型再回切</div>
      {tip && <div style={{ fontSize: 12, color: 'var(--teal)' }}><IconCheck size={12} /> {tip}</div>}
      {targets.length === 0 && <div className="empty-state">尚未配置 Provider——先在「模型与 Provider」中添加并拉取模型列表</div>}
      <div className="set-sec">
        {types.map((t) => {
          const value = routing[t] ?? '';
          const target = targets.find(x => x.value === value);
          return (
            <div className="set-row" key={t}>
              <div className="set-row-l">
                <span className="set-row-label">{t}</span>
                <span className="set-row-desc">
                  {value ? (target ? `${target.contextWindow ? `${Math.round(target.contextWindow / 1000)}k · ` : ''}${target.vision ? '支持视觉' : '不支持视觉'}` : `已配置 ${value}（该模型未在 Provider 中登记）`) : '未配置，使用右上角当前模型'}
                </span>
              </div>
              <select
                className="set-input" style={{ width: 260 }} value={value} aria-label={`${t} 路由目标`}
                onChange={(e) => {
                  const next = { ...routing };
                  if (!e.target.value) delete next[t]; else next[t] = e.target.value;
                  void commit(next);
                }}
              >
                <option value="">（不路由）</option>
                {targets.map((x) => <option key={x.value} value={x.value}>{x.vision ? '◉ ' : ''}{x.label}</option>)}
              </select>
            </div>
          );
        })}
        {used.map((t) => (
          <div className="set-row" key={t}>
            <div className="set-row-l">
              <span className="set-row-label">{t}</span>
              <span className="set-row-desc">自定义类目（非内置任务类型，按 classifyTask 结果匹配）</span>
            </div>
            <button className="btn-ghost" style={{ height: 28, fontSize: 11 }} onClick={() => { const next = { ...routing }; delete next[t]; void commit(next); }}>移除</button>
          </div>
        ))}
      </div>
    </>
  );
}

/** 用户规则：全局/项目提示规则编辑 + 策略规则（免审批/禁止）表 */
function RulesSection() {
  const [view, setView] = useState<RulesView | null>(null);
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [file, setFile] = useState('AGENTS.md');
  const [draft, setDraft] = useState('');
  const [tip, setTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setView(await rulesApi.get()); } catch (e) { toast.error(`规则没读到：${e instanceof Error ? e.message : String(e)}`); }
  };
  useEffect(() => { void load(); }, []);

  const options = scope === 'global'
    ? (view?.globalFiles ?? []).map(f => f.name)
    : ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.maharness/rules/'];
  const pickFile = (name: string) => {
    setFile(name);
    if (scope === 'global') setDraft(view?.globalFiles.find(f => f.name === name)?.content ?? '');
    else setDraft(view?.projectFiles.find(f => f.name.endsWith(name) || f.name === name)?.content ?? '');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (scope === 'global') await rulesApi.putGlobal(file.endsWith('.md') ? file : `${file}.md`, draft);
      else await rulesApi.putProject(file, draft);
      await load();
      setTip('规则已写入并在下一轮对话生效');
      setTimeout(() => setTip(null), 3000);
    } catch (e) { toast.error(`规则没保存上：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  const togglePolicy = async (idx: number, patch: Record<string, unknown>) => {
    if (!view) return;
    const next = view.policy.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    const r = await rulesApi.putPolicy(scope, next as RulesView['policy']);
    if (!r.ok) { toast.error(r.error ?? '这条策略没保存上'); return; }
    await load();
  };

  const addPolicy = async () => {
    if (!view) return;
    const next = [...view.policy, { id: `rule-${Date.now().toString(36)}`, effect: 'allow', tool: 'powershell_execute', argPattern: 'npm run test', reason: '测试命令免审批', enabled: true }];
    const r = await rulesApi.putPolicy(scope, next as RulesView['policy']);
    if (!r.ok) { toast.error(r.error ?? '这条规则没加上'); return; }
    await load();
  };

  const removePolicy = async (idx: number) => {
    if (!view) return;
    const next = view.policy.filter((_, i) => i !== idx);
    await rulesApi.putPolicy(scope, next as RulesView['policy']);
    await load();
  };

  if (!view) return <div className="empty-state">读取规则中…</div>;

  return (
    <>
      <span className="page-title">用户规则</span>
      <div className="page-sub">告诉 maharness 你/这个项目要求什么。规则文件即事实源，可 git 版本化；工作区切换自动重读</div>
      {tip && <div style={{ fontSize: 12, color: 'var(--teal)' }}><IconCheck size={12} /> {tip}</div>}
      {view.errors.length > 0 && <div style={{ fontSize: 12, color: 'var(--red)' }}>策略文件问题：{view.errors.join('；')}</div>}

      <div className="set-sec">
        <span className="ss-title">提示规则</span>
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label">作用域</span>
            <span className="set-row-desc">当前注入 {view.promptChars} 字符 · 生效路径：全局 data/rules/ + 项目 AGENTS.md/CLAUDE.md/.maharness/rules/</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['project', 'global'] as const).map((s) => (
              <button key={s} className={`btn-ghost${scope === s ? ' on' : ''}`} style={{ height: 28, fontSize: 11 }} onClick={() => { setScope(s); const first = s === 'global' ? (view.globalFiles[0]?.name ?? 'maharness.md') : 'AGENTS.md'; pickFile(first); }}>
                {s === 'project' ? '项目' : '全局'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="set-input" style={{ width: 240 }} value={options.includes(file) ? file : options[0] ?? ''} onChange={(e) => pickFile(e.target.value)} aria-label="规则文件">
            {options.length === 0 && <option value="">（暂无文件）</option>}
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          {scope === 'global' && (
            <button className="btn-ghost" style={{ height: 30, fontSize: 11 }} onClick={() => { setFile('new-rule.md'); setDraft(''); }}>新建 .md</button>
          )}
        </div>
        <textarea
          className="set-input rule-editor" rows={12} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'写自然语言即可，例如：\n- 提交信息用中文，遵循 feat/fix/chore 前缀\n- 改完代码必须跑 npm run typecheck\n- 不要动 src/legacy/ 下的文件'}
          aria-label="规则正文"
        />
        <div>
          <button className="btn-ok" onClick={() => void save()} disabled={busy}>{busy ? <span className="spin" /> : null}保存规则</button>
        </div>
      </div>

      <div className="set-sec">
        <span className="ss-title">策略规则（审批与拦截）</span>
        <div className="page-sub">allow = 该类调用免审批（每次放行都进轨迹留痕）；deny = 直接拒绝；作用于 {scope === 'project' ? '本项目 .maharness/rules.json' : '全局 data/rules.json'}</div>
        {view.policy.length === 0 && <div className="empty-state" style={{ padding: '12px' }}>尚无策略规则——默认按内置白名单判定（只读命令免审批）</div>}
        {view.policy.map((r, i) => (
          <div className="set-row" key={r.id ?? i}>
            <div className="set-row-l">
              <span className="set-row-label"><code>{r.tool}</code> {r.argPattern ? <code>/{r.argPattern}/</code> : null}</span>
              <span className="set-row-desc">{r.reason || '（无说明）'}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select className="set-input" style={{ width: 120, height: 28 }} value={r.effect} onChange={(e) => void togglePolicy(i, { effect: e.target.value })} aria-label="策略效果">
                <option value="allow">allow</option>
                <option value="deny">deny</option>
                <option value="require-approval">需审批</option>
              </select>
              <button className={`toggle ${r.enabled === false ? '' : 'on'}`} role="switch" aria-checked={r.enabled !== false} aria-label="启用策略" onClick={() => void togglePolicy(i, { enabled: r.enabled === false })}><span className="knob" /></button>
              <button className="pd-btn danger" style={{ height: 28, fontSize: 11, padding: '0 10px' }} onClick={() => void removePolicy(i)}>删</button>
            </div>
          </div>
        ))}
        <div><button className="btn-ghost" style={{ height: 28, fontSize: 11 }} onClick={() => void addPolicy()}>+ 添加策略（npm run test 免审批）</button></div>
      </div>
    </>
  );
}

function readAutoScroll(): boolean {
  try { return localStorage.getItem('maharness-auto-scroll') !== 'off'; } catch { return true; }
}

const BRANDS: { key: Brand; label: string; dots: string }[] = [
  { key: 'doodle', label: '涂鸦手账（珊瑚红 · 草绿 · 橘）', dots: 'linear-gradient(90deg,#ff6a45,#4fb8a5,#ffa62b)' },
  { key: 'ink', label: '墨线单色（低刺激，适合长时间编码）', dots: 'linear-gradient(90deg,#d8d2c8,#8f8a80,#b6afa3)' },
  { key: 'moss', label: '苔绿（安静耐用）', dots: 'linear-gradient(90deg,#6fa87c,#4e9c8f,#d2a25c)' },
];

function GeneralSection({ theme, onThemeChange, brand, onBrandChange }: { theme: Theme; onThemeChange: (t: Theme) => void; brand: Brand; onBrandChange: (b: Brand) => void }) {
  const [autoScroll, setAutoScroll] = useState(readAutoScroll);
  return (
    <>
      <span className="page-title">通用</span>
      <div className="page-sub">外观、语言与基础行为</div>
      <div className="set-sec">
        <span className="ss-title">外观</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">深色主题</span>
            <span className="set-row-desc">{theme === 'dark' ? '深色（当前）· 深夜炭纸手账涂鸦' : '浅色（当前）· 米白点阵纸手账涂鸦'}</span>
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
        <div className="set-row">
          <div className="set-row-l">
            <span className="set-row-label">品牌色板</span>
            <span className="set-row-desc">同一套手账骨架下切换品牌身份，与明暗正交组合（3 套 × 2 明暗）</span>
          </div>
          <div className="brand-swatches">
            {BRANDS.map((b) => (
              <button
                key={b.key}
                type="button"
                className={`brand-swatch${brand === b.key ? ' on' : ''}`}
                style={{ background: b.dots }}
                title={b.label}
                aria-label={b.label}
                aria-pressed={brand === b.key}
                onClick={() => onBrandChange(b.key)}
              />
            ))}
          </div>
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

export default function SettingsView({ providers, onChanged, theme, onThemeChange, brand, onBrandChange }: Props) {
  const [tab, setTab] = useState<SettingTab>('general');
  const navs: { key: SettingTab; label: string; badge?: string }[] = [
    { key: 'general', label: '通用' },
    { key: 'providers', label: '模型与 Provider' },
    { key: 'context', label: '上下文管理' },
    { key: 'routing', label: '模型路由' },
    { key: 'rules', label: '用户规则' },
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
        {tab === 'general' && <GeneralSection theme={theme} onThemeChange={onThemeChange} brand={brand} onBrandChange={onBrandChange} />}
        {tab === 'providers' && <ProvidersSection providers={providers} onChanged={onChanged} />}
        {tab === 'context' && <ContextSection />}
        {tab === 'routing' && <RoutingSection />}
        {tab === 'rules' && <RulesSection />}
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
