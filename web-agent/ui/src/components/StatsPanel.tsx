// ui/src/components/StatsPanel.tsx —— 统计面板：上下文用量 / 缓存命中率 / 总体概览
import { useEffect, useState } from 'react';
import { statsApi } from '../api';
import type { StatsInfo } from '../types';

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const cost = (n: number) => `$${n.toFixed(6)}`;

function Bar({ pct, warn }: { pct: number; warn?: boolean }) {
  const w = Math.min(100, pct);
  return (
    <div className="stats-bar">
      <div className={`stats-bar-fill ${warn ? 'warn' : ''}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export default function StatsPanel() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await statsApi.get();
        if (alive) { setStats(s); setErr(null); }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = setInterval(load, 5000); // 周期刷新（成本/缓存随对话实时变化）
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div className="provider-panel"><div className="provider-msg err">统计加载失败: {err}</div></div>;
  if (!stats) return <div className="provider-panel"><div className="empty-hint">统计加载中…</div></div>;

  const { overview, process, context, cache, taskProfile } = stats;
  const ctxTotal = context.perSession.reduce((s, p) => s + p.estimatedTokens, 0);

  return (
    <div className="stats-panel">
      <div className="panel-section-title">📊 信息统计</div>

      <div className="provider-hint">全局概览（历史累计，来自本地数据库）</div>
      <div className="stats-grid">
        <div className="stats-card"><div className="stats-num">{overview.sessions}</div><div className="stats-label">会话</div></div>
        <div className="stats-card"><div className="stats-num">{fmt(overview.messages)}</div><div className="stats-label">消息</div></div>
        <div className="stats-card"><div className="stats-num">{fmt(overview.tokensIn + overview.tokensOut)}</div><div className="stats-label">总 tokens</div></div>
        <div className="stats-card"><div className="stats-num">{cost(overview.cost)}</div><div className="stats-label">总成本</div></div>
        <div className="stats-card"><div className="stats-num">{overview.truncations}</div><div className="stats-label">截断次数</div></div>
        <div className="stats-card"><div className="stats-num">{overview.cacheHitSteps}</div><div className="stats-label">缓存命中步</div></div>
      </div>

      <div className="provider-hint">本次运行（进程内累计，重启清零）</div>
      <div className="stats-grid">
        <div className="stats-card"><div className="stats-num">{process.llmCalls}</div><div className="stats-label">LLM 调用</div></div>
        <div className="stats-card"><div className="stats-num">{process.toolCalls}</div><div className="stats-label">工具调用</div></div>
        <div className="stats-card"><div className="stats-num">{fmt(process.tokensIn)}</div><div className="stats-label">输入 tokens</div></div>
        <div className="stats-card"><div className="stats-num">{fmt(process.tokensOut)}</div><div className="stats-label">输出 tokens</div></div>
        <div className="stats-card"><div className="stats-num">{cost(process.cost)}</div><div className="stats-label">成本</div></div>
      </div>

      <div className="panel-section-title">🧠 上下文用量</div>
      {taskProfile.length > 0 && (
        <>
          <div className="panel-section-title">📈 任务画像（自适应数据源）</div>
          <div className="provider-hint">harness 按任务类型统计：次数 / 平均轮数 / 平均成本 / 失败率——自适应策略的输入</div>
          {taskProfile.map((t) => (
            <div key={t.type} className="stats-row">
              <div className="stats-row-head">
                <span className="stats-row-title">{t.type}</span>
                <span className="stats-row-meta">{t.count} 次 · 平均 {t.avgTurns} 轮 · ${t.avgCost.toFixed(5)}</span>
              </div>
              <Bar pct={t.failRate} warn={t.failRate > 30} />
              <div className="stats-row-sub">失败率 <b>{t.failRate}%</b></div>
            </div>
          ))}
        </>
      )}      <div className="provider-hint">预算 {fmt(context.maxTokens)} tokens/会话，超出时自动截断较早历史</div>
      <div className="stats-grid">
        <div className="stats-card"><div className="stats-num">{fmt(ctxTotal)}</div><div className="stats-label">全部会话估算</div></div>
        <div className="stats-card"><div className="stats-num">{context.perSession.filter((s) => s.truncated).length}</div><div className="stats-label">已截断会话</div></div>
      </div>
      {context.perSession.length === 0 && <div className="empty-hint">暂无会话</div>}
      {context.perSession.slice(0, 10).map((s) => (
        <div key={s.id} className="stats-row">
          <div className="stats-row-head">
            <span className="stats-row-title" title={s.title}>{s.title}</span>
            <span className="stats-row-meta">
              {s.messages} 条 · {fmt(s.estimatedTokens)} tok
              {s.truncated && <em className="stats-tag warn">截断×{s.truncations}</em>}
              <em className="stats-tag">{s.mode === 'normal' ? '' : s.mode}</em>
            </span>
          </div>
          <Bar pct={s.contextUsage} warn={s.contextUsage > 80} />
          <div className="stats-row-sub">
            {fmt(s.tokensIn)} in / {fmt(s.tokensOut)} out · {cost(s.cost)}
            <span className={s.contextUsage > 80 ? 'warn-text' : ''}>{s.contextUsage}%</span>
          </div>
        </div>
      ))}

      <div className="panel-section-title">⚡ 缓存命中率</div>
      <div className="provider-hint">
        L1 语义问答{!cache.l1Enabled && '（未配置 embedding，未启用）'} · L2 工具结果缓存 · L3 prompt 前缀复用
      </div>
      <div className="stats-row">
        <div className="stats-row-head">
          <span className="stats-row-title">综合（L1 回答 + L2 结果 + L3 前缀）</span>
          <span className="stats-row-meta">服务 {cache.overall.served} / {cache.overall.total} 轮次</span>
        </div>
        <Bar pct={cache.overall.rate} warn={cache.overall.rate < 50} />
        <div className="stats-row-sub">综合命中率 <b>{cache.overall.rate}%</b></div>
      </div>
      <div className="stats-row">
        <div className="stats-row-head">
          <span className="stats-row-title">L1 语义问答</span>
          <span className="stats-row-meta">{cache.l1.hits} 命中 / {cache.l1.misses} 未命中</span>
        </div>
        <Bar pct={cache.l1.rate} />
        <div className="stats-row-sub">命中率 <b>{cache.l1.rate}%</b>（相同/近似问题直接返回缓存答案，零 LLM 成本）</div>
      </div>
      <div className="stats-row">
        <div className="stats-row-head">
          <span className="stats-row-title">L2 工具结果</span>
          <span className="stats-row-meta">{cache.l2.hits} 命中 / {cache.l2.misses} 未命中</span>
        </div>
        <Bar pct={cache.l2.rate} />
        <div className="stats-row-sub">命中率 <b>{cache.l2.rate}%</b></div>
      </div>
      <div className="stats-row">
        <div className="stats-row-head">
          <span className="stats-row-title">L3 前缀复用</span>
          <span className="stats-row-meta">{cache.l3.hits} 次复用</span>
        </div>
        <div className="stats-row-sub">累计复用 <b>{fmt(cache.l3.tokens)}</b> tokens（provider KV cache 直接命中）</div>
      </div>
      {cache.savedCost > 0 && (
        <div className="provider-hint">缓存累计节省约 <b>{cost(cache.savedCost)}</b></div>
      )}
    </div>
  );
}
