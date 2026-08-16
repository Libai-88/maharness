/**
 * kernel/scope.ts —— 可逆效应引擎（借鉴 Cordis/DeepSeek 的 revertible effects，落地为轻量运行时机制）
 *
 * 第一性原理：动态组合的正确性不能靠每个作者的勤勉（VSCode 问题的根源），
 * 而应由运行时结构性保证——「组件做什么、它就在自己的作用域里留下逆元；
 * 组件消失时，运行时按 LIFO 顺序执行逆元，环境完全恢复」。
 *
 * 设计映射（见 docs/ARCHITECTURE.md §时空可组合性）：
 *  - 论文的 effect context (γ, φ)  → 本实现 EffectScope 的 LIFO 逆元栈；
 *  - 论文的 track(𝑓, 𝑔)           → scope.add(inverse)：执行 f 并登记其逆元 g；
 *  - 论文的 recover(γ, φ)         → scope.dispose()：armed 置 false（幂等，最多执行一次）
 *                                    + 按逆序执行全部逆元；
 *  - 论文的 twisted composition   → 逆元栈天然按「后进先出」累积（复合逆元 = 逆序复合）；
 *  - 论文的 self-disposal         → dispose 幂等：armed=false 同时阻止在途迭代继续追加。
 *
 * 系统边界（论文 §6.1）：本引擎只追踪「界内」副作用——能力注册/事件订阅/配置写入/
 * 服务提供（进程内、可独占修改、可恢复）。界外发射（写文件/发消息/调 LLM）不在此列，
 * 它们由 Trace 审计 + 审批补偿（见 docs/ARCHITECTURE.md §边界与补偿）。
 */
export type Inverse = () => void | Promise<void>;

/** 可逆效应作用域：一个组件（插件）的全部副作用在此累积，dispose 时按 LIFO 完全恢复 */
export class EffectScope {
  /** 逆元栈：dispose 时按逆序执行（后注册的副作用先恢复） */
  private inverses: Inverse[] = [];
  private armed = true;
  /** 已执行的逆元数（可观测性：卸载时记录「回滚了几项」） */
  reverted = 0;

  get isArmed(): boolean {
    return this.armed;
  }

  get size(): number {
    return this.inverses.length;
  }

  /**
   * 登记一个逆元（调用方已在作用域外执行了正向效果）。
   * 返回一个幂等撤销函数（可在无需卸载时单独撤销——如 register 返回的 unregister）。
   * 作用域已 dispose 后调用返回 no-op（不追加），保证 in-flight 操作不会在恢复后留下尾巴。
   */
  add(inverse: Inverse): () => void {
    this.inverses.push(inverse);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const i = this.inverses.indexOf(inverse);
      if (i >= 0) this.inverses.splice(i, 1);
    };
  }

  /**
   * 执行一个效应并自动登记其逆元：callback 返回的逆元（或 Promise 解析出的逆元）
   * 被推入作用域。callback 抛错时逆元不被登记（正向效果未完成，无需恢复）。
   */
  async effect<T>(callback: () => T | Promise<T>, makeInverse: (value: T) => Inverse): Promise<void> {
    if (!this.armed) return;
    const value = await callback();
    if (!this.armed) return; // 执行期间被 dispose：不登记（状态已恢复，逆元可能已不适用）
    this.add(makeInverse(value));
  }

  /** 登记子作用域：父作用域 dispose 时按 LIFO 连带回收子作用域（组件卸载级联到其子效果） */
  child(): EffectScope {
    const c = new EffectScope();
    this.add(() => c.dispose());
    return c;
  }

  /** 执行全部逆元（LIFO）。幂等：armed=false 后再次调用直接返回（self-disposal）。 */
  async dispose(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    const stack = this.inverses;
    this.inverses = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      try {
        await stack[i]();
        this.reverted++;
      } catch (err) {
        console.warn('[scope] 逆元执行失败（已尽力而为，其余继续）:', err instanceof Error ? err.message : String(err));
      }
    }
  }
}
