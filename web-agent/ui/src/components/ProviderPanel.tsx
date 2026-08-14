// ui/src/components/ProviderPanel.tsx —— 供应商管理（网页端配置 LLM）
import { useState } from 'react';
import { providersApi } from '../api';
import type { ProviderForm, ProviderInfo } from '../types';

interface Props {
  providers: ProviderInfo[];
  onChanged: () => void;
}

const EMPTY: ProviderForm = { label: '', baseUrl: '', apiKey: '', model: '', priceIn: '', priceOut: '' };

export default function ProviderPanel({ providers, onChanged }: Props) {
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
    if (ok) {
      setCreating(false);
      setEditing(null);
      onChanged();
    }
  };

  const startCreate = () => { setCreating(true); setEditing(null); setForm(EMPTY); setMsg(null); };
  const startEdit = (p: ProviderInfo) => {
    setEditing(p);
    setCreating(false);
    setForm({ label: p.label, baseUrl: p.baseUrl, apiKey: '', model: p.model, priceIn: p.priceIn ? String(p.priceIn) : '', priceOut: p.priceOut ? String(p.priceOut) : '' });
    setMsg(null);
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || (creating && !form.apiKey.trim())) {
      return refresh(false, '名称 / 地址 / 模型必填，新建时 Key 必填');
    }
    setBusy(true);
    try {
      if (creating) {
        await providersApi.create(form);
        await refresh(true, '已添加');
      } else if (editing) {
        await providersApi.update(editing.id, form);
        await refresh(true, '已保存');
      }
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!form.baseUrl.trim() || !form.model.trim() || (!creating && !form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, '请先填写地址 / 模型 / Key 再测试');
    }
    setBusy(true);
    try {
      const r = await providersApi.test({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        ...(editing ? { providerId: editing.id } : {}),
      });
      if (r.ok) await refresh(true, r.message ?? '连接成功');
      else await refresh(false, r.error ?? '连接失败');
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p: ProviderInfo) => {
    try {
      await providersApi.update(p.id, { enabled: !p.enabled });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const remove = async (p: ProviderInfo) => {
    if (!confirm(`删除供应商「${p.label}」？`)) return;
    try {
      await providersApi.remove(p.id);
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const set = (k: keyof ProviderForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const showForm = creating || editing;

  return (
    <div className="provider-panel">
      {msg && <div className={`provider-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {!showForm && (
        <>
          <button className="btn new-session" onClick={startCreate}>＋ 添加供应商</button>
          <div className="provider-hint">配置立即热生效，无需重启。Key 仅存本地数据库，列表不回显。</div>
          {providers.map((p) => (
            <div key={p.id} className={`provider-card ${p.enabled ? '' : 'disabled'}`}>
              <div className="provider-head">
                <span className="provider-name">{p.label}</span>
                <button className={`toggle ${p.enabled ? 'on' : ''}`} onClick={() => void toggle(p)} title={p.enabled ? '停用' : '启用'}>
                  {p.enabled ? '启用中' : '已停用'}
                </button>
              </div>
              <div className="provider-meta">{p.model}</div>
              <div className="provider-meta">{p.baseUrl}</div>
              <div className="provider-meta">Key: {p.hasKey ? p.apiKeyMasked : '未配置'} {p.priceIn != null ? `· 价格 ↑${p.priceIn} ↓${p.priceOut}` : ''}</div>
              <div className="provider-actions">
                <button onClick={() => startEdit(p)}>编辑</button>
                <button onClick={() => void remove(p)} className="danger">删除</button>
              </div>
            </div>
          ))}
          {providers.length === 0 && <div className="empty-hint">还没有供应商——点击上方按钮添加第一个</div>}
        </>
      )}

      {showForm && (
        <div className="provider-form">
          <div className="provider-form-title">{creating ? '添加供应商' : `编辑 · ${editing!.label}`}</div>
          <label>名称<input value={form.label} onChange={set('label')} placeholder="如 DeepSeek" /></label>
          <label>API 地址<input value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://api.deepseek.com/v1" /></label>
          <label>API Key{editing && <em>（留空保持不变）</em>}
            <input value={form.apiKey} onChange={set('apiKey')} placeholder={editing?.hasKey ? 'sk-****（已配置）' : 'sk-...'} type="password" />
          </label>
          <label>模型<input value={form.model} onChange={set('model')} placeholder="deepseek-chat" /></label>
          <div className="provider-form-row">
            <label>价格 ↑(USD/M)<input value={form.priceIn ?? ''} onChange={set('priceIn')} placeholder="可选" /></label>
            <label>价格 ↓(USD/M)<input value={form.priceOut ?? ''} onChange={set('priceOut')} placeholder="可选" /></label>
          </div>
          <div className="provider-actions">
            <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? '处理中…' : '保存'}</button>
            <button onClick={() => void test()} disabled={busy}>测试连接</button>
            <button onClick={() => { setCreating(false); setEditing(null); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
