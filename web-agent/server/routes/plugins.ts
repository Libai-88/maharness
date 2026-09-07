/**
 * server/routes/plugins.ts —— 插件管理 + Capabilities Registry（能力发现）
 */
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { openInExplorer, type RouteDeps } from './shared';

/** 常见插件错误 → 修复建议（面向用户的技术指引） */
function suggestFix(errorMsg: string): string | undefined {
  if (!errorMsg) return undefined;
  const lower = errorMsg.toLowerCase();
  if (lower.includes('缺少依赖') || lower.includes('依赖未加载')) {
    const match = errorMsg.match(/依赖[插件:\s]+[:：]?\s*(\S+)/);
    const dep = match?.[1] ?? 'xxx';
    return `请先安装并启用依赖插件「${dep}」，然后重试。`;
  }
  if (lower.includes('配置校验失败')) return '请检查 config.json 中该插件的配置是否符合 schema 要求。';
  if (lower.includes('超时')) return '插件启动超时，可能在 onLoad/onStart 中有耗时操作或死循环。';
  if (lower.includes('解析失败') || (lower.includes('syntax') && lower.includes('json'))) return 'plugin.json 格式错误，请用 JSON 校验器检查后修复。';
  if (lower.includes('找不到') || lower.includes('does not exist')) return '入口文件不存在，请检查 plugin.json 的 "entry" 字段。';
  if (lower.includes('id 冲突') || lower.includes('不一致')) return '插件 id 与已注册插件冲突，请修改为唯一值。';
  if (lower.includes('熔断')) return '插件连续失败已进入熔断保护，系统会在冷却后自动重试。';
  return undefined;
}

export function registerPluginRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  // ---------- Capabilities Registry（能力发现） ----------
  /** 动态能力注册表：LLM 能力/风险/成本/审批/限制一目了然（人类与前端可查） */
  app.get('/api/capabilities', (_req, res) => {
    const tools = kernel.plugins.capabilities('tool').map((c) => ({
      name: c.tool.name,
      risk: c.tool.risk ?? 'low',
      costHint: c.tool.costHint ?? 'low',
      approval: c.tool.approval ?? false,
      limits: c.tool.limits ?? null,
      description: c.tool.description,
    }));
    const contexts = kernel.plugins.capabilities('context').map((c) => ({
      id: c.context.id,
      weight: c.context.weight ?? 0,
      description: c.context.description,
    }));
    const personas = kernel.plugins.capabilities('persona').map((c) => ({
      id: c.persona.id, name: c.persona.name, priority: c.persona.priority ?? 0,
    }));
    res.json({
      tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
      contexts,
      personas,
      byRisk: {
        high: tools.filter((t) => t.risk === 'high').map((t) => t.name),
        medium: tools.filter((t) => t.risk === 'medium').map((t) => t.name),
      },
    });
  });

  // ---------- 插件管理 ----------
  app.get('/api/plugins', (_req, res) => {
    // kernel 侧 list() 是不暴露内部结构的投影（无 caps 字段）；caps 从实例补齐
    res.json(kernel.plugins.list().map((p) => ({
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
      state: p.state,
      caps: (kernel.plugins.get(p.manifest.id)?.caps ?? []).map((c) => c.kind),
      error: p.error,
      fixSuggestion: p.error ? suggestFix(p.error) : undefined,
      essential: p.manifest.essential,
      circuitBreaker: p.circuitBreaker,
    })));
  });

  app.post('/api/plugins/:id/actions', async (req, res) => {
    const { action } = req.body ?? {};
    const id = req.params.id;
    try {
      if (action === 'enable') await kernel.plugins.enable(id);
      else if (action === 'disable') await kernel.plugins.disable(id);
      else if (action === 'reload') await kernel.plugins.reload(id);
      else if (action === 'uninstall') await kernel.plugins.uninstall(id);
      else return res.status(400).json({ error: `未知操作: ${action}` });
      const inst = kernel.plugins.get(id);
      res.json({ ok: true, state: inst?.state ?? 'uninstalled' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 用系统文件管理器打开插件源码目录
  app.post('/api/plugins/:id/open', (req, res) => {
    const inst = kernel.plugins.get(req.params.id);
    if (!inst) return res.status(404).json({ error: '插件不存在' });
    if (!existsSync(inst.dir)) return res.status(404).json({ error: '插件目录不存在' });
    openInExplorer(inst.dir);
    res.json({ ok: true, path: inst.dir });
  });

  // 插件配置只读查看：返回 config.<pluginId>.* 的键值对
  app.get('/api/plugins/:id/config', (req, res) => {
    const inst = kernel.plugins.get(req.params.id);
    if (!inst) return res.status(404).json({ error: '插件不存在' });
    const section = kernel.config.section(req.params.id);
    const schema = inst.manifest.config;
    res.json({ id: req.params.id, config: section, schema: schema ?? null });
  });
}
