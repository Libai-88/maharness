// ui/src/components/SkillsView.tsx —— 技能系统（Screen 6）：已安装（内置/包/项目/用户）+ 市场 + 锁同步 + 自进化提案 + 详情
import { useEffect, useState } from 'react';
import { evolveApi, skillsApi } from '../api';
import type { LockSkill, SkillInfo, SkillProposal, SkillUsageRow } from '../types';
import { IconClose, IconSpark } from './Icon';
import { toast } from 'sonner';

const COLORS = ['#e8930f', '#43a047', '#e0512f', '#8a63e8', '#d94630', '#9c8d74'];

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  builtin: '内置', pack: '技能包', user: '已安装', project: '项目',
};

export default function SkillsView() {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [market, setMarket] = useState<{ name: string; description: string }[]>([]);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [lock, setLock] = useState<LockSkill[]>([]);
  const [usage, setUsage] = useState<Record<string, SkillUsageRow>>({});
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const [r, l, u, e] = await Promise.all([
        skillsApi.list(),
        skillsApi.lock().catch(() => ({ file: null, count: 0, skills: [] as LockSkill[] })),
        skillsApi.usage().catch(() => ({ usage: {} as Record<string, SkillUsageRow> })),
        evolveApi.list().catch(() => ({ proposals: [] as SkillProposal[], pending: 0, toolStats: {} })),
      ]);
      setInstalled(r.installed);
      setMarket(r.market);
      setLock(l.skills ?? []);
      setUsage(u.usage ?? {});
      setProposals((e.proposals ?? []).filter(p => p.status === 'pending'));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => { void load(); }, []);

  const syncLock = async () => {
    if (busy) return;
    setBusy('sync');
    try {
      const r = await skillsApi.sync();
      const okCount = r.results.filter(x => x.installed).length;
      const bad = r.results.filter(x => !x.ok);
      if (bad.length) toast.error(`同步完成 ${okCount} 个，${bad.length} 个失败：${bad[0].error ?? ''}`);
      else toast.success(okCount ? `已从 skills-lock.json 安装 ${okCount} 个技能` : '锁文件中的技能均已安装');
      await load();
    } catch (e) { toast.error(`同步失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  };

  const decide = async (p: SkillProposal, action: 'accept' | 'reject') => {
    if (busy) return;
    setBusy(`${p.id}-${action}`);
    try {
      const r = action === 'accept' ? await evolveApi.accept(p.id) : await evolveApi.reject(p.id);
      if (!r.ok) { toast.error(r.error ?? '操作失败'); return; }
      toast.success(action === 'accept' ? `已采纳为技能：${(r as { name?: string }).name ?? p.name}` : '已忽略该提案');
      await load();
    } catch (e) { toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  };

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
    const u = usage[s.name];
    return (
      <div
        key={`${s.source}-${s.name}`}
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
            <span className="skill-tag builtin">{SOURCE_LABEL[s.source]}</span>
            {s.shadowed?.length ? <span className="skill-tag" title={`被以下来源的同名技能覆盖：${s.shadowed.join('、')}`}>覆盖 {s.shadowed.join('/')}</span> : null}
          </div>
          <span className="skill-desc">{s.description}</span>
          {u && (
            <span className="skill-usage" title="索引出现次数 / 正文读取次数 / 累计读入 token">
              索引 {u.indexShown} · 读取 {u.reads}
              {u.bodyTokens ? ` · ${u.bodyTokens >= 1000 ? `${(u.bodyTokens / 1000).toFixed(1)}k` : u.bodyTokens} tok` : ''}
            </span>
          )}
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
          {lock.some(l => !l.installed) && <span className="msg-tag">锁文件待装 {lock.filter(l => !l.installed).length}</span>}
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

        {proposals.length > 0 && (
          <>
            <div className="plugin-group">自进化 · 待你确认的技能提案（{proposals.length}）</div>
            {proposals.map((p) => (
              <div key={p.id} className="skill-card proposal-card">
                <span className="skill-icon" style={{ background: 'var(--hl-soft)', color: 'var(--orange)' }}><IconSpark size={15} /></span>
                <div className="skill-info">
                  <div className="skill-info-top">
                    <span className="skill-name">{p.name}</span>
                    {p.signals.map(sg => <span key={sg} className="skill-tag">{sg}</span>)}
                    {p.seen > 1 && <span className="skill-tag" title="同一信号再次出现">第 {p.seen} 次</span>}
                  </div>
                  <span className="skill-desc">{p.description}</span>
                  <span className="skill-usage">{p.reason}{p.question ? ` · 触发：${p.question.slice(0, 60)}` : ''}</span>
                </div>
                <div className="skill-right">
                  <button className="btn-sm primary" disabled={busy === `${p.id}-accept`} onClick={() => void decide(p, 'accept')}>
                    {busy === `${p.id}-accept` ? <span className="spin" /> : null}采纳
                  </button>
                  <button className="btn-sm ghost" disabled={busy === `${p.id}-reject`} onClick={() => void decide(p, 'reject')}>忽略</button>
                </div>
              </div>
            ))}
          </>
        )}

        {lock.length > 0 && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>
              skills-lock.json · GitHub 源可同步 {lock.filter(l => !l.installed).length}/{lock.length}
              <button className="btn-sm ghost" style={{ marginLeft: 8 }} disabled={busy === 'sync'} onClick={() => void syncLock()}>
                {busy === 'sync' ? <span className="spin" /> : null}同步安装
              </button>
            </div>
            {lock.filter(l => !l.installed && (!kw || l.name.toLowerCase().includes(kw))).slice(0, 12).map((l) => (
              <div key={l.name} className="skill-card">
                <span className="skill-icon" style={{ background: 'var(--blue-soft)', color: 'var(--accent)' }}><IconSpark size={15} /></span>
                <div className="skill-info">
                  <div className="skill-info-top">
                    <span className="skill-name">{l.name}</span>
                    <span className="skill-tag" title={l.skillPath}>{l.source}</span>
                  </div>
                  <span className="skill-desc">{l.skillPath}{l.computedHash ? ` · sha256 ${l.computedHash.slice(0, 12)}…` : ''}</span>
                </div>
                <div className="skill-right"><span className="skill-status">未安装</span></div>
              </div>
            ))}
          </>
        )}

        <div className="plugin-group">已安装 · 内置</div>
        {installed.filter((s) => s.source === 'builtin' && match(s)).map((s, i) => renderCard(s, i))}
        {installed.some((s) => s.source === 'project' && match(s)) && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已安装 · 项目级（.claude/skills 等）</div>
            {installed.filter((s) => s.source === 'project' && match(s)).map((s, i) => renderCard(s, i))}
          </>
        )}
        {installed.some((s) => s.source === 'pack' && match(s)) && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已安装 · 技能包</div>
            {installed.filter((s) => s.source === 'pack' && match(s)).map((s, i) => renderCard(s, i))}
          </>
        )}
        {installed.some((s) => s.source === 'user' && match(s)) && (
          <>
            <div className="plugin-group" style={{ marginTop: 12 }}>已安装 · 用户</div>
            {installed.filter((s) => s.source === 'user' && match(s)).map((s, i) => renderCard(s, i))}
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
                <span className="pd-ver">{SOURCE_LABEL[selected.source]} 技能 · get_skill 可读全文</span>
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
