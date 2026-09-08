/**
 * core/vision/index.ts —— 图像能力中介（能力路由，不改消息模型）
 * 设计：图片不进主对话上下文（省 token、且文本网关根本不认），
 *  read_image 只做登记（沙箱内 + 类型/大小校验），analyze_image 把图片交给
 *  **具备视觉能力的模型**做一次分析，结果以文本回传给原模型继续工作。
 *  若当前模型本身支持视觉，则就地用当前模型分析（不发生切换）。
 *  整个过程记入 Trace（vision-route 步骤），UI 可见"借了谁的眼看"。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { LLMMessage, Plugin, ProviderDef } from '../../kernel/types';
import { resolveInSandbox, isDeniedReadPath } from '../../kernel/sandbox';
import { capabilityFor } from '../chat/provider';
import { routeForCapability, capabilitySatisfied } from '../chat/routing';
import type { RouteDecision } from '../chat/routing';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
/** 单图 base64 上限（字节，原图）：base64 后约 ×1.37 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 内存里保留的最近图片数 */
const STORE_MAX = 12;

interface ImageRef { id: string; path: string; mime: string; bytes: number; dataUrl: string; at: number }

let store: ImageRef[] = [];
let seq = 0;

function remember(ref: ImageRef): void {
  store.push(ref);
  if (store.length > STORE_MAX) store.shift();
}
const findImage = (id: string): ImageRef | undefined => store.find(r => r.id === id);

export default {
  id: 'vision',
  name: '图像能力',
  version: '0.1.0',
  onLoad(ctx) {
    const enabled = ctx.config.get<boolean>('vision.enabled', true);
    const maxBytes = Math.max(64 * 1024, ctx.config.get<number>('vision.maxBytes', MAX_IMAGE_BYTES));
    const defaultPrompt = ctx.config.get<string>('vision.defaultPrompt', '');

    let chatSvc: { providers: ProviderDef[] } | undefined;
    ctx.inject('service:chat', (v) => {
      chatSvc = v as { providers: ProviderDef[] } | undefined;
    });
    const providers = (): ProviderDef[] => chatSvc?.providers ?? [];

    /** 发起一次视觉分析（独立于主循环：不写库、不进历史） */
    async function analyze(
      target: { provider: ProviderDef; model: string },
      dataUrl: string,
      question: string,
    ): Promise<{ ok: boolean; text?: string; error?: string; tokensIn: number; tokensOut: number }> {
      const messages: LLMMessage[] = [{
        role: 'user',
        content: question,
        images: [dataUrl],
      }];
      let text = '';
      let tokensIn = 0;
      let tokensOut = 0;
      try {
        for await (const chunk of target.provider.chat(messages, { model: target.model, maxTokens: 1500 })) {
          if (chunk.type === 'delta') text += chunk.text;
          else if (chunk.type === 'usage') { tokensIn = chunk.input; tokensOut = chunk.output; }
        }
        return { ok: true, text: text.trim(), tokensIn, tokensOut };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), tokensIn, tokensOut };
      }
    }

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'vision-rules',
        name: '图像工具规则',
        description: '约束 LLM 正确看图',
        priority: 12,
        content: [
          '图像工具规则：',
          '1. 需要看图片（截图/图表/UI 效果/照片里的文字）时：先 read_image(path) 登记，再 analyze_image 让视觉模型读图；',
          '2. analyze_image 的 question 要具体（"列出图中所有报错文字""描述布局与配色"），泛泛问"这是什么"只会得到泛泛答；',
          '3. 图片内容只来自 analyze_image 的返回，不要凭文件名猜图；分析不可信或图不清晰时如实说明；',
          '4. 没有可用视觉模型时如实告知用户去「设置」里配置多模态模型，不要编造图像内容。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'read_image',
        risk: 'low',
        costHint: 'low',
        limits: `仅图片（png/jpg/gif/webp/bmp）；单图 ≤${Math.round(maxBytes / 1024 / 1024)}MB；路径须在沙箱内`,
        output: '{imageId, path, mime, bytes, note}',
        description: '登记一张图片供后续分析（不读取像素、不塞进上下文）。返回 imageId，配合 analyze_image 使用。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '图片路径（相对沙箱根目录）' } },
          required: ['path'],
        },
        async handler(args: { path?: string }, tctx) {
          if (!enabled) return { ok: false, error: '视觉能力已由配置关闭' };
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isDeniedReadPath(file, tctx.sandboxRoot)) return { ok: false, error: '拒绝读取该路径（.env / data/ 内部数据）' };
          if (!existsSync(file)) return { ok: false, error: `文件不存在: ${args.path}` };
          const mime = MIME[extname(file).toLowerCase()];
          if (!mime) return { ok: false, error: `不支持的图片类型（支持 ${Object.keys(MIME).join(' ')}）` };
          const st = statSync(file);
          if (!st.isFile()) return { ok: false, error: '目标不是文件' };
          if (st.size > maxBytes) return { ok: false, error: `图片过大（${st.size} 字节 > ${maxBytes}）` };
          const ref: ImageRef = {
            id: `img-${Date.now().toString(36)}-${++seq}`,
            path: args.path ?? '', mime, bytes: st.size,
            dataUrl: `data:${mime};base64,${readFileSync(file).toString('base64')}`,
            at: Date.now(),
          };
          remember(ref);
          const canSee = tctx.providerId ? capabilitySatisfied({ vision: true }, providers().find(p => p.id === tctx.providerId) ?? ({} as ProviderDef), tctx.model ?? '') : false;
          return {
            ok: true,
            data: {
              imageId: ref.id, path: ref.path, mime, bytes: st.size,
              note: canSee
                ? '当前模型自带视觉，analyze_image 将就地分析（不切换模型）。'
                : '当前模型不支持视觉，调用 analyze_image 会自动借道可用的多模态模型，分析结果以文本回传后继续你的工作。',
            },
          };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'analyze_image',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 90_000,
        limits: '一次一张；结果按文本返回，原图不进入对话历史',
        output: '{answer, model, provider, routed, tokensIn, tokensOut}',
        description: '把已登记的图片交给具备视觉能力的模型分析并返回文本结论。当前模型不支持视觉时自动路由到可用的多模态模型（同 provider 优先、其次价格低），分析结束即回到原模型继续任务。',
        parameters: {
          type: 'object',
          properties: {
            imageId: { type: 'string', description: 'read_image 返回的 imageId（与 path 二选一）' },
            path: { type: 'string', description: '未登记时可直接给图片路径（相对沙箱根目录）' },
            question: { type: 'string', description: '要视觉模型回答的具体问题' },
          },
          required: ['question'],
        },
        async handler(args: { imageId?: string; path?: string; question?: string }, tctx) {
          if (!enabled) return { ok: false, error: '视觉能力已由配置关闭' };
          let ref = args.imageId ? findImage(String(args.imageId)) : undefined;
          if (!ref && args.path) {
            const file = resolveInSandbox(tctx.sandboxRoot, String(args.path));
            const mime = MIME[extname(file).toLowerCase()];
            if (!mime) return { ok: false, error: `不支持的图片类型: ${args.path}` };
            if (!existsSync(file)) return { ok: false, error: `文件不存在: ${args.path}` };
            const st = statSync(file);
            if (st.size > maxBytes) return { ok: false, error: `图片过大（${st.size} 字节）` };
            ref = {
              id: `img-${Date.now().toString(36)}-${++seq}`, path: String(args.path), mime, bytes: st.size,
              dataUrl: `data:${mime};base64,${readFileSync(file).toString('base64')}`, at: Date.now(),
            };
            remember(ref);
          }
          if (!ref) return { ok: false, error: '找不到图片：先 read_image 或直接传 path' };
          const question = String(args.question ?? '').trim() || defaultPrompt || '请详细描述这张图片的内容，包括其中所有可读文字。';
          const list = providers();
          if (!list.length) return { ok: false, error: '尚未配置任何 Provider，无法分析图片' };

          const currentProvider = list.find(p => p.id === tctx.providerId) ?? list[0];
          const currentModel = tctx.model || currentProvider.defaultModel;
          let target = { provider: currentProvider, model: currentModel };
          let routed = false;
          let decision: RouteDecision | undefined;
          void decision;

          if (!capabilitySatisfied({ vision: true }, currentProvider, currentModel)) {
            const pick = routeForCapability({ vision: true }, list, { providerId: currentProvider.id, model: currentModel });
            if (!pick) {
              const known = list.map(p => `${p.id}@${p.defaultModel}`).join('、');
              return { ok: false, error: `当前模型 ${currentProvider.id}@${currentModel} 不支持视觉，且可用 provider 中没有任何带视觉能力的模型（已配置：${known}）。请在「设置 → 供应商」拉取模型列表（会自动识别视觉能力）或配置一个多模态模型。` };
            }
            target = { provider: pick.provider, model: pick.model };
            routed = true;
          }

          const step = ctx.trace.startStep({
            traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'system', name: routed ? 'vision-route' : 'vision-local',
            inputSummary: `${currentProvider.id}@${currentModel} ← ${ref.path || ref.id}`,
          });
          const r = await analyze(target, ref.dataUrl, question);
          if (!r.ok) {
            step.fail(`视觉分析失败：${r.error ?? ''}`, { outputSummary: `${target.provider.id}@${target.model}` });
            return { ok: false, error: `视觉模型 ${target.provider.id}@${target.model} 调用失败：${r.error}` };
          }
          step.finish({
            outputSummary: routed ? `借道 ${target.provider.id}@${target.model} 分析，结果以文本回传 ${currentModel}` : `就地 ${target.model} 分析`,
            tokensIn: r.tokensIn, tokensOut: r.tokensOut,
          });
          return {
            ok: true,
            data: {
              answer: r.text,
              image: { id: ref.id, path: ref.path, mime: ref.mime, bytes: ref.bytes },
              model: target.model, provider: target.provider.id,
              routed, backTo: routed ? `${currentProvider.id}@${currentModel}` : undefined,
              tokensIn: r.tokensIn, tokensOut: r.tokensOut,
            },
          };
        },
      },
    });

    const visionCapable = providers().flatMap(p => (p.models ?? []).filter(m => m.vision).map(m => `${p.id}@${m.modelId}`));
    ctx.logger.info(`图像能力就绪: read_image / analyze_image（当前${visionCapable.length ? ` 已有多模态模型 ${visionCapable.slice(0, 3).join('、')}${visionCapable.length > 3 ? '…' : ''}` : ' 无带视觉能力的模型，读图会给出配置指引'}）`);
  },
} satisfies Plugin;

/** 供 UI/统计展示：内存中最近登记过的图片（不含 base64） */
export function recentImages(): { id: string; path: string; mime: string; bytes: number; at: number }[] {
  return store.map(r => ({ id: r.id, path: r.path, mime: r.mime, bytes: r.bytes, at: r.at }));
}

/** 未登记模型的能力兜底（供测试与自检引用） */
export const _capabilityFor = capabilityFor;
