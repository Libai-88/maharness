// ui/src/components/SkillsView.tsx —— 技能系统（Screen 6）：已安装（内置/用户）+ 市场 + 详情（真实 skillsApi）
import { useEffect, useState } from 'react';
import { skillsApi } from '../api';
import type { SkillInfo } from '../types';
import { IconClose, IconSpark } from './Icon';

const COLORS = ['#d9a441', '#82a873', '#d0856b', '#e0913f', '#d96856', '#6b6053'];

export default function SkillsView() {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [market, setMarket] = useState<{ name: string; description: string }[]>([]);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await skillsApi.list();
      setInstalled(r.installed);
      setMarket(r.market);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => { void load(); }, []);

  const install = async (name: string) => {
    if (installing) return;
    setInstalling(name);
    try { await skillsApi.install(name); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setInstalling(null); }
  };

  const uninstall = async (s: SkillInfo) => {
    if (!confirm(`卸载技能 ${s.name}？`)) return;
    setUninstalling(s.name);
    try {
      await skillsApi.uninstall(s.name);
      if (selected?.name === s.name) { setSelected(null); setGuide(null); }
      await load();
    }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setUninstalling(null); }
  };

  const readGuide = async (s: SkillInfo) => {
    setSelected(s);
    setGuide(null);
    try { const r = await skillsApi.read(s.name, s.source); setGuide(r.content); }
    catch (e) { setGuide(`读取失败：${e instanceof Error ? e.message : String(e)}`); }
  };

  const kw = q.trim().toLowerCase();
  const match = (s: SkillInfo) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw);

  const renderCard = (s: SkillInfo, i: number) => {
    const color = COLORS[i % COLORS.length];
    return (
      <div
        key={s.name}
        className={`skill-card ${selected?.name === s.name ? 'selected' : ''}`}
        onClick={() => void readGuide(s)}
        role="button"
        tabIndex={0}
        aria-pressed={selected?.name === s.name}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void readGuide(s); } }}
      >
        <span className="skill-icon" style={{ background: `${color}26`, color }}>{s.name[0]?.toUpperCase()}</span>
        <div className="skill-info">
          <div className="skill-info-top">
            <span className="skill-name">{s.name}</span>
            <span className="skill-tag builtin">{s.source === 'builtin' ? '内置' : s.source === 'pack' ? '技能包' : '用户'}</span>
          </div>
          <span className="skill-desc">{s.description}</span>
        </div>
        <div className="skill-right">
          <span className="skill-status">可用</span>
          {s.source === 'user' && (
            <button
              className="btn-sm ghost"
              disabled={uninstalling === s.name}
              onClick={(e) => { e.stopPropagation(); void uninstall(s); }}
            >{uninstalling === s.name ? <span className="spin" /> : null}卸载</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="plugins-layout">
      <div className="plugins-list">
        <div className="page-head">
          <div className="ph-eyebrow">
            <span className="ph-no">06</span>
            <span className="ph-label">SKILL SYSTEM</span>
            <span className="ph-rule" />
            <span className="ph-cn">技能系统</span>
          </div>
          <span className="ph-title">让 maharness 学会你的手艺</span>
          <span className="ph-sub">技能即扩展——Markdown 指南 + YAML 声明，装入即可被 Agent 调用。</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span className="msg-tag">已安装 {installed.length}</span>
          <span style={{ marginLeft: 'auto' }}>
            <input
              className="set-input" style={{ width: 180, height: 32 }}
              placeholder="搜索技能…" value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索技能"
            />
          </span>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

        <div className="plugin-group">已安装 · 内置</div>
        {installed.filter((s) => s.source === 'builtin' && match(s)).map((s, i) => renderCard(s, i))}
        {installed.some((s) => s.source === 'pack' && match(s)) && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已安装 · 技能包（ARS 学术）</div>
            {installed.filter((s) => s.source === 'pack' && match(s)).map((s, i) => renderCard(s, installed.filter((x) => x.source === 'builtin').length + i))}
          </>
        )}
        {installed.some((s) => s.source === 'user' && match(s)) && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已安装 · 用户</div>
            {installed.filter((s) => s.source === 'user' && match(s)).map((s, i) => renderCard(s, installed.filter((x) => x.source === 'builtin').length + i))}
          </>
        )}
        {installed.filter(match).length === 0 && kw !== '' && <div className="empty-state" style={{ padding: '24px 12px' }}>没有匹配「{q.trim()}」的技能</div>}
        {market.length > 0 && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>技能市场 · 可安装</div>
            {market.filter((m) => !kw || m.name.toLowerCase().includes(kw) || m.description.toLowerCase().includes(kw)).map((m) => (
              <div key={m.name} className="skill-card">
                <span className="skill-icon" style={{ background: 'var(--blue-soft)', color: 'var(--accent)' }}><IconSpark size={15} /></span>
                <div className="skill-info">
                  <div className="skill-info-top">
                    <span className="skill-name">{m.name}</span>
                    <span className="skill-tag" style={{ background: 'var(--blue-soft)', color: 'var(--accent)' }}>市场</span>
                  </div>
                  <span className="skill-desc">{m.description}</span>
                </div>
                <button className="btn-sm primary" disabled={installing === m.name} onClick={() => void install(m.name)}>
                  {installing === m.name ? <span className="spin" /> : null}安装
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <aside className="manager-panel">
        <div className="manager-head">
          <span className="manager-title">技能详情</span>
          <button className="manager-close" onClick={() => { setSelected(null); setGuide(null); }} aria-label="关闭详情"><IconClose size={13} /></button>
        </div>
        <div className="manager-body">
          {selected ? (
            <>
              <div className="skill-detail-card">
                <span className="pd-icon" style={{ background: 'var(--purple-soft)', color: 'var(--purple)' }}>{selected.name[0]?.toUpperCase()}</span>
                <span className="pd-name">{selected.name}</span>
                <span className="pd-ver">{selected.source === 'builtin' ? '内置' : selected.source === 'pack' ? '技能包' : '用户'} 技能 · 指南可读</span>
                <span className="sd-desc">{selected.description}</span>
              </div>
              <div className="pd-manifest">
                <span className="pm-title">GUIDE · SKILL.md</span>
                {guide ? (
                  <pre className="code-body" style={{ background: 'var(--bg-input)', borderRadius: 8, border: '1px solid var(--border)', maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{guide}</pre>
                ) : (
                  <span className="sd-desc" style={{ color: 'var(--text-3)' }}>读取中…</span>
                )}
              </div>
              <button className="btn-ok" style={{ width: '100%' }} onClick={() => { if (selected) void readGuide(selected); }} disabled={!selected}>get_skill 读取指南</button>
            </>
          ) : (
            <div className="empty-state">← 选择技能查看指南</div>
          )}
        </div>
      </aside>
    </div>
  );
}
