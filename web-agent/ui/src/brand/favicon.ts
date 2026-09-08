/**
 * ui/src/brand/favicon.ts —— 随主题翻转的 favicon（与侧栏/头像共用负空间剪影，brand/sheep.ts）
 * C 方向（负空间）：实心羊毛 + M 角 + 挖空光标眼；mask 挖洞，任何底色下都正确。
 * 颜色取自当前生效的 CSS token，主题/品牌切换时重写 <link rel="icon">。
 */
import { sheepSolidSvg } from './sheep';

function token(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function applyFavicon(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const tile = theme === 'light' ? token('--accent', '#ff6a45') : token('--bg-panel', '#221f1e');
  const ink = theme === 'light' ? '#fff8ec' : token('--accent', '#ff6a45');
  const svg = sheepSolidSvg(ink, { id: 'fav', bg: tile });
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}
