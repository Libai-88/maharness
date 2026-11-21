# ADR 0002：Host Service 与 Plugin 的边界

## 背景

maharness 的产品能力持续进入 `server/`：组织、社会、复盘、自动化、事项目前都是宿主模块。`kernel` 仍是薄内核，但 `server/` 已接近第二个内核；routes 直接构造领域服务，server 还直接 import core 内部实现。

## 决策

1. 明确两类扩展：
   - **Host Service**：必须随宿主进程运行、拥有持久事实和 Run 生命周期，例如 organization、society、experience、automation。
   - **Plugin**：通过 `kernel/plugin-sdk` 注册能力、可独立加载/卸载，例如 chat、tools-fs、search、mcp。
2. Host Service 统一由 `server/host/container.ts` 构造一次，routes 通过 `HostPorts` 窄接口访问，不直接 import 具体 service 类。
3. server 对 core 的依赖必须经过 `server/host/adapters/`；core 通过稳定 service key 暴露能力，server 不 import core 内部文件。
4. `kernel/plugin-sdk` 是 plugin 唯一公共入口；host service 边界不属于 plugin API，因此不改变插件 manifest 的 `3.0.0`。

## 后果

- 允许破坏 `RouteDeps` 的内部形态和 service 构造方式，但不改变 Run 事实和租户隔离。
- 大型 service 拆成领域模块，保留 facade，降低回归风险。
- `server` 不能再绕过 port 直接新增领域耦合；否则 boundary 测试失败。

## 回滚

回退到 v0.1.x 的 `server/host-services.ts` + 具体 service 的装配方式；数据库和插件契约不受本 ADR 影响。