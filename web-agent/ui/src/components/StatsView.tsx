// ui/src/components/StatsView.tsx —— 统计视图（Screen 3）：三层缓存 + 全局概览（真实 statsApi）
import { useEffect, useState } from 'react';
import { statsApi } from '../api';
import type { StatsInfo } from '../types';

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const cost = (n: number) => `¥${n.toFixed(2)}`;

function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }

export default function StatsView() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const s = await statsApi.get(); if (alive) { setStats(s); setErr(null); } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div className="view-scroll"><div className="empty-state">统计加载失败：{err}</div></div>;
  if (!stats) return <div className="view-scroll"><div className="empty-state">统计加载中…</div></div>;

  const { overview, process, cache } = stats;
  const overall = cache.overall;
  const l1 = cache.l1 ?? { hits: 0, misses: 0, rate: 0 };
  const l2 = cache.l2 ?? { hits: 0, misses: 0, rate: 0 };
  const l3 = cache.l3 ?? { hits: 0, tokens: 0 };

  return (
    <div className="view-scroll">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <span className="page-title">缓存与成本</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="tb-live"><span className="live-dot" />实时</span>
        </span>
      </div>
      <div className="page-sub">本周节省 {cost(cache.savedCost ?? 0)} · 三层缓存命中即可见</div>

      <div className="stats-row">
        <div className="hero-card">
          <div className="hero-head">
            <span className="hero-label">综合命中率 · HIT RATE</span>
            <span className="hero-badge">{cache.l3.realHits > 0 ? 'L3 真实命中' : cache.l1Enabled ? 'L1 已启用' : 'L1 关闭'}</span>
          </div>
          <div className="hero-value">{pct(cache.l3.realHits > 0 ? cache.l3.realRate / 100 : (overall?.rate ?? 0) / 100)}</div>
          <div className="hero-sub">
            {cache.l3.realHits > 0
              ? `provider 确认命中 ${fmt(cache.l3.realTokens)} tok · 折合 ${cost(cache.savedCost ?? 0)}`
              : `节省调用 ${overall?.served ?? 0} 次 · 折合 ${cost(cache.savedCost ?? 0)}`}
          </div>
          <div className="hero-chart">
            <div className="hc-bars">
              {[36, 44, 28, 52, 48, 60, 64].map((h, i) => (
                <div key={i} className="hc-bar" style={{ height: h }} />
              ))}
            </div>
            <div className="hc-labels"><span>Mon</span><span>Wed</span><span>Sun</span></div>
          </div>
        </div>
        <div className="saved-card">
          <span className="sc-label">本周节省调用</span>
          <span className="sc-value">{overall?.served ?? 0}</span>
          <span className="sc-sub">次 · LLM call skipped</span>
          <div className="sc-divider" />
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--purple)' }} /><span className="sc-lbl">L1 语义缓存</span></div>
            <span className="sc-val">{l1.hits}</span>
          </div>
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--teal)' }} /><span className="sc-lbl">L2 工具结果</span></div>
            <span className="sc-val">{l2.hits}</span>
          </div>
          <div className="sc-row">
            <div className="sc-row-left"><span className="sc-dot" style={{ background: 'var(--accent)' }} /><span className="sc-lbl">L3 prompt 前缀</span></div>
            <span className="sc-val">{l3.hits}</span>
          </div>
        </div>
      </div>

      <div className="cache-cards">
        <div className="cache-card c1">
          <div className="cc-head">
            <span className="cc-badge b1">L1 语义问答</span>
            <span className="cc-rate">{pct(l1.rate ?? 0)}</span>
          </div>
          <span className="cc-desc">字符 bigram · Dice 相似度</span>
          <span className="cc-meta">命中 {l1.hits} · 完全跳过 LLM{cache.l1Enabled ? '' : ' · 已关闭'}</span>
          <div className="cc-bar"><div className="cc-bar-fill" /></div>
          <span className="cc-example">阈值 ≥ 0.85 触发命中 · 免 embedding API</span>
        </div>
        <div className="cache-card c2">
          <div className="cc-head">
            <span className="cc-badge b2">L2 工具结果</span>
            <span className="cc-rate">{pct(l2.rate ?? 0)}</span>
          </div>
          <span className="cc-desc">hash(工具+参数) + mtime/size</span>
          <span className="cc-meta">命中 {l2.hits} · TTL 30 min · 重复调用不重算</span>
          <div className="cc-bar"><div className="cc-bar-fill" /></div>
          <span className="cc-example">适用 read_file / list_dir / glob</span>
        </div>
        <div className="cache-card c3">
          <div className="cc-head">
            <span className="cc-badge b3">L3 prompt 前缀</span>
            <span className="cc-rate">{cache.l3.realHits > 0 ? pct(cache.l3.realRate / 100) : fmt(l3.hits)}</span>
          </div>
          <span className="cc-desc">消息只追加不重写 → KV cache</span>
          <span className="cc-meta">
            真实命中 {fmt(cache.l3.realTokens ?? 0)} tok
            {cache.l3.realHits > 0 ? ` · 命中率 ${pct(cache.l3.realRate / 100)}` : ' · 估算 ' + fmt(l3.tokens ?? 0) + ' tok'}
          </span>
          <div className="cc-bar"><div className="cc-bar-fill" /></div>
          <span className="cc-example">多轮对话输入成本按 provider 折扣计费</span>
        </div>
      </div>

      <div className="global-stats">
        <div className="gs-item">
          <span className="gsi-label">会话</span>
          <span className="gsi-value">{overview.sessions}</span>
          <span className="gsi-sub">历史累计</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">消息</span>
          <span className="gsi-value">{fmt(overview.messages)}</span>
          <span className="gsi-sub">用户 + 助手</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">TOKENS</span>
          <span className="gsi-value">{fmt(overview.tokensIn + overview.tokensOut)}</span>
          <span className="gsi-sub">in {fmt(overview.tokensIn)} · out {fmt(overview.tokensOut)}</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">成本</span>
          <span className="gsi-value teal">{cost(overview.cost)}</span>
          <span className="gsi-sub">已含缓存节省</span>
        </div>
        <div className="gs-item">
          <span className="gsi-label">截断次数</span>
          <span className="gsi-value orange">{overview.truncations}</span>
          <span className="gsi-sub">上下文超限自动截断</span>
        </div>
      </div>

      <div className="set-sec">
        <span className="ss-title">本次运行（进程内累计）</span>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">执行步骤</span><span className="set-row-desc">LLM 调用 + 工具调用 + 缓存命中</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}>{process.steps}</span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">LLM 调用</span><span className="set-row-desc">实际请求模型次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}>{process.llmCalls}</span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">工具调用</span><span className="set-row-desc">Agent 执行工具次数</span></div>
          <span className="sc-val" style={{ fontSize: 16 }}>{process.toolCalls}</span>
        </div>
        <div className="set-row">
          <div className="set-row-l"><span className="set-row-label">本次成本</span><span className="set-row-desc">进程内累计（含缓存折扣）</span></div>
          <span className="sc-val teal" style={{ fontSize: 16 }}>{cost(process.cost)}</span>
        </div>
      </div>
    </div>
  );
}
