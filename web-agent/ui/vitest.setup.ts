import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 每个用例后卸载已渲染组件，避免 DOM 残留污染下一个用例。
afterEach(() => cleanup());
