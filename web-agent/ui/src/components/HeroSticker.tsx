// ui/src/components/HeroSticker.tsx —— 首页「胶带拍立得」贴纸 · 可换图的趣味功能
// 点击相纸即可从本地挑选一张图片替换；经 canvas 等比缩小（≤640px）后存 localStorage，
// 持久化到下次访问；下次点击可再换，右下「恢复默认」回到出厂人像。
import { useRef, useState } from 'react';
import { IconPolaroid, IconSwapPhoto } from './Icon';

const STORAGE_KEY = 'maharness-sticker';
const DEFAULT_SRC = '/hero-char.webp';
const MAX_EDGE = 640;

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
}
function writeStored(v: string) {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* 忽略写满等异常 */ }
}
function clearStored() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 忽略 */ }
}

/** 等比缩小图片（压缩体积，避免 localStorage 超限），仍返回 dataURL */
function shrink(dataUrl: string, max = MAX_EDGE): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      if (!ctx) return resolve(dataUrl);
      // 保持透明 PNG 的透明底，JPEG 会变黑——统一铺白背景再压 JPEG
      ctx.fillStyle = '#fffdf6';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export default function HeroSticker() {
  const [src, setSrc] = useState<string | null>(readStored);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    setBusy(true);
    try {
      const raw = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      });
      const small = await shrink(raw);
      setSrc(small);
      writeStored(small);
    } catch { /* 读取失败静默 */ }
    setBusy(false);
  };

  const reset = () => {
    setSrc(null);
    clearStored();
  };

  return (
    <figure className={`hero-sticker ${src && src !== DEFAULT_SRC ? 'custom' : ''}`}>
      <button
        className="hs-photo"
        onClick={pick}
        title="点击换一张图片"
        aria-label="更换首页贴纸照片"
        disabled={busy}
      >
        <img src={src ?? DEFAULT_SRC} alt="首页贴纸照片" />
        <span className="hs-hint">{busy ? '处理中…' : <>换一张 <IconSwapPhoto size={12} /></>}</span>
      </button>
      {src && src !== DEFAULT_SRC && (
        <button className="hs-reset" onClick={reset} title="恢复默认" aria-label="恢复默认贴纸">
          <IconPolaroid size={12} />
        </button>
      )}
      <figcaption>{src && src !== DEFAULT_SRC ? '我拍的贴纸 ✦' : '你的羊 · 贴纸 No.1'}</figcaption>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} hidden aria-hidden="true" />
    </figure>
  );
}
