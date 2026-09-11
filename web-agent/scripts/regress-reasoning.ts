// scripts/regress-reasoning.ts —— 思考分流真机回归：五项断言（注册临时 provider → 发消息 → 校验 → 清理）
// 用法：node --import tsx scripts/regress-reasoning.ts
//   本地：读 .env 的 NEWAPI_API_KEY / NEWAPI_BASE_URL
//   CI：读环境变量 NEWAPI_API_KEY（密钥不落盘），用例经 REGRESS_MODELS 配置（逗号分隔）
// 前置：服务已在 localhost:3000 运行（CI 由 workflow 负责拉起）
// 断言：① SSE 思考非空 ② 正文 delta 非空 ③ 思考先于正文（分流时序）
//       ④ 最终 content 不含 reasoning 片段 ⑤ 落库 reasoning 存在且正文无 think 标签
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

// 密钥来源：环境变量优先（CI secrets），回退 .env（本地）
function resolveApiKey(): string | undefined {
  const fromEnv = process.env.NEWAPI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return env.split('\n').find((l) => l.startsWith('NEWAPI_API_KEY='))?.slice('NEWAPI_API_KEY='.length).trim();
  } catch { return undefined; }
}

function resolveBaseUrl(): string {
  if (process.env.NEWAPI_BASE_URL) return process.env.NEWAPI_BASE_URL;
  try {
    const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return env.split('\n').find((l) => l.startsWith('NEWAPI_BASE_URL='))?.split('=')[1].trim()
      ?? 'https://newapi.qwqtao.one/v1';
  } catch { return 'https://newapi.qwqtao.one/v1'; }
}

const apiKey = resolveApiKey();
if (!apiKey) {
  const msg = '未提供 NEWAPI_API_KEY（CI secrets 或 .env）——真机思考分流回归需要真实 LLM，跳过';
  if (process.env.CI) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`SKIP: ${msg}`);
  process.exit(0);
}
const baseUrl = resolveBaseUrl();

// 用例：默认 R1 + Qwen 思考系；REGRESS_MODELS 可覆盖（逗号分隔模型名）
const models = (process.env.REGRESS_MODELS ?? 'deepseek-r1:free,qwen3.6-plus:free')
  .split(',').map((m) => m.trim()).filter(Boolean);
const QUESTION = '在吗？用一句话回答。';

async function jfetch(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text().catch(() => '')}`);
  return r;
}

interface Verdict { ok: boolean; detail: string }

/** 单次执行：建会话 → 流式对话 → 收集事件 → 落库校验（失败由调用方重试） */
async function runOnce(model: string): Promise<Verdict> {
  const p = await (await jfetch('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: `tmp-regress-${model}`, baseUrl, apiKey, model }),
  })).json() as { id: string };
  try {
    const s = await (await jfetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })).json() as { id: string };
    try {
      const chat = await fetch(`${BASE}/api/sessions/${s.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: QUESTION, model }),
      });
      if (!chat.ok || !chat.body) throw new Error(`chat → ${chat.status}`);
      const reader = chat.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let reasoningLen = 0;
      let contentLen = 0;
      let reasoningBeforeDelta = false;
      let deltaSeen = false;
      let finalContent = '';
      let finalReasoning = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const b of blocks) {
          let ev = 'message';
          const data: string[] = [];
          for (const line of b.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (!data.length) continue;
          let d: Record<string, unknown>;
          try { d = JSON.parse(data.join('\n')); } catch { continue; }
          if (ev === 'reasoning') {
            const t = String(d.text ?? '');
            if (!deltaSeen && t) reasoningBeforeDelta = true;
            reasoningLen += t.length;
            finalReasoning += t;
          } else if (ev === 'delta') {
            deltaSeen = true;
            contentLen += String(d.text ?? '').length;
          } else if (ev === 'done') {
            finalContent = String(d.content ?? '');
            finalReasoning = String(d.reasoning ?? '');
          } else if (ev === 'error') {
            throw new Error(`LLM 错误：${d.error}`);
          }
        }
      }
      const msgs = await (await jfetch(`/api/sessions/${s.id}/messages`)).json() as { role: string; content: string | null; reasoning?: string }[];
      const a = [...msgs].reverse().find((m) => m.role === 'assistant');
      const storedContent = a?.content ?? '';
      const storedReasoning = a?.reasoning ?? '';
      const probe = finalReasoning.slice(0, 60).trim();
      const leaks = [
        ['SSE 思考非空', reasoningLen > 0],
        ['正文 delta 非空', contentLen > 0],
        ['思考先于正文', reasoningBeforeDelta],
        ['content 不含 reasoning 片段', !(probe.length >= 20 && finalContent.includes(probe))],
        ['落库 reasoning 存在且正文无标签', !!storedReasoning && !/<(think|thinking|thought|reasoning)>/i.test(storedContent)],
      ] as const;
      const failed = leaks.filter(([, ok]) => !ok);
      const detail = [
        `reasoning=${reasoningLen}ch content=${contentLen}ch`,
        `落库 content="${storedContent.trim().slice(0, 40)}" reasoning=${storedReasoning.length}ch`,
        failed.length ? `未通过: ${failed.map(([n]) => n).join(' / ')}` : '五项断言全过',
      ].join(' | ');
      return { ok: failed.length === 0, detail };
    } finally {
      await jfetch(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  } finally {
    await jfetch(`/api/providers/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function main() {
  const results: string[] = [];
  let failed = false;
  for (const model of models) {
    let verdict: Verdict | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        verdict = await runOnce(model);
        break;
      } catch (e) {
        if (attempt === 2) {
          failed = true;
          results.push(`${model}: FAIL（重试后仍异常）——${e instanceof Error ? e.message : String(e)}`);
        } else {
          console.log(`[${model}] 第 ${attempt} 次异常，重试：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (verdict) {
      if (!verdict.ok) failed = true;
      results.push(`${model}: ${verdict.ok ? 'PASS' : 'FAIL'}（${verdict.detail}）`);
    }
  }
  console.log('\n===== 思考分流真机回归 =====');
  for (const r of results) console.log(r);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('回归失败:', e); process.exit(1); });
