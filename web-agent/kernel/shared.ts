/**
 * kernel/shared.ts —— 跨模块副本的共享单例原语
 *
 * 为什么需要它（缺陷 B13）：插件经 `kernel/plugin-snapshot.ts` 从**内容快照目录**
 * `<name>@<hash>/` 加载，而 `server/`、`scripts/` 等处仍可能 `import` **活目录**
 * `core/<name>/…`。两者路径不同 → Node ESM 视为两个模块实例 → 各自的模块顶层
 * `const x = new Map()` / `export const store = new Store()` 是**两份状态**。
 * 后果不是"浪费一点内存"，而是**写进一份、读另一份**：
 *  - `core/chat/result-store.ts`：执行器（快照副本）put，工具/测试（活副本）get → 重读必然 miss；
 *  - `core/chat/provider-health.ts`：agent（快照副本）记账失败，`GET /api/providers`（活副本）读健康 →
 *    设置页的红标与「密钥失效」横幅永远看不见真实故障。
 *
 * 本模块提供进程内唯一的一处登记中心（globalThis 命名空间），使同一逻辑状态在
 * 任意份模块副本下都解析到同一实例。**约定**：插件若有「需要跨副本共享」的模块级
 * 可变状态（存储、健康表、连接表），一律经 `sharedSingleton()` 取，不要写裸的
 * 模块顶层 `new Map()`；纯函数与只读常量不受影响。
 *
 * 内核不持有任何业务语义——这里只有「按 key 取实例」这一机制。
 */

/** 登记中心在 globalThis 上的命名空间键（避免与其它全局量冲突） */
const REGISTRY_KEY = '__maharness_shared_registry__';

type Registry = Map<string, unknown>;

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  let r = g[REGISTRY_KEY] as Registry | undefined;
  if (!r) {
    r = new Map<string, unknown>();
    g[REGISTRY_KEY] = r;
  }
  return r;
}

/**
 * 取（或首次创建）一个进程内唯一实例。
 * key 用「插件名.状态名」形式（如 `chat.resultStore`、`chat.providerHealth`）——
 * 命名空间挂在插件 id 下，避免不同插件互相占用同名键。
 *
 * 注意：`make` 可能被调用多次吗？不会——首次创建后即复用；但 `make` 必须是**纯创建**
 * （无副作用登记），因为并发下以「先到者」的实例为准。
 */
export function sharedSingleton<T>(key: string, make: () => T): T {
  const r = registry();
  if (r.has(key)) return r.get(key) as T;
  const created = make();
  r.set(key, created);
  return created;
}

/** 只读取已存在的实例（测试/诊断用；未创建返回 undefined，不会创建） */
export function peekShared<T>(key: string): T | undefined {
  return registry().get(key) as T | undefined;
}

/** 清空登记中心（仅供测试隔离使用；生产代码不得调用） */
export function __resetSharedForTests(): void {
  registry().clear();
}
