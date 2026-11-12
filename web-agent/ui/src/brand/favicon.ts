/**
 * ui/src/brand/favicon.ts —— 随主题翻转的 favicon（通用 Bot 标记）
 * 颜色取自当前生效的 CSS token，主题/品牌切换时重写 <link rel="icon">。
 */

function token(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function applyFavicon(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const tile = theme === 'light' ? token('--brand-primary', '#b94727') : token('--card', '#1b1a18');
  const ink = theme === 'light' ? '#fffaf7' : token('--brand-primary', '#e06d48');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5.5" fill="${tile}"/><g stroke="${ink}" stroke-width="1.8" stroke-linecap="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></g></svg>`;
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
