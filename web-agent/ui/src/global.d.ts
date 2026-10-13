// ui/src/global.d.ts —— 构建期注入的全局常量声明（见 vite.config.ts 的 define）
/** 应用版本号：由 Vite 从 ui/package.json 注入（E10：版本号单一来源）。 */
declare const __APP_VERSION__: string;
