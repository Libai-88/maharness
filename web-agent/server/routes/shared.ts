/**
 * server/routes/shared.ts —— 路由层共享工具的汇总出口
 *
 * 原先 506 行的口袋文件按关注点拆开（ADR 0010），工具本体落在 `server/http/`：
 *   - `http/scope.ts`        租户与注册依赖
 *   - `http/sse.ts`          事件帧与连接配额
 *   - `http/security.ts`     密钥掩码、SSRF 边界、逐跳校验抓取
 *   - `http/exec.ts`         沙箱 git 与文件管理器
 *   - `http/chat-service.ts` 对话能力层端口解析与热刷新
 *
 * 放在 `http/` 而不是 `routes/`，是为了让 `usecases/` 也能用这些无状态的协议工具，
 * 而不必反向 import 路由层（依赖方向：routes → usecases → services/store）。
 */
export * from '../http/scope';
export * from '../http/sse';
export * from '../http/security';
export * from '../http/exec';
export * from '../http/chat-service';
