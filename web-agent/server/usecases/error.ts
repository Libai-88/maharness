/** 用例层统一的错误出口：带 HTTP 语义的拒绝，路由只负责把它映射成响应。 */
export class UsecaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
