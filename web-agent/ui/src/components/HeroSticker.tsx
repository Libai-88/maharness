// ui/src/components/HeroSticker.tsx —— 首页贴纸 · 可换图的趣味功能
// 点击图片即可从本地挑选一张图片替换；经 canvas 等比缩小（≤640px）后存 localStorage，
// 持久化到下次访问；下次点击可再换，右上「恢复默认」回到出厂图片。
import { useRef, useState } from 'react';
import { Camera, RotateCcw } from 'lucide-react';
import imageCompression from 'browser-image-compression';
import { BRAND_LOGO_SRC } from '@/brand/BrandMark';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from '@/components/ui/attachment';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'maharness-sticker';
const DEFAULT_SRC = BRAND_LOGO_SRC;
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

/** 等比缩小并压缩图片（避免 localStorage 超限），返回 dataURL */
async function shrink(file: File, max = MAX_EDGE): Promise<string> {
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: max,
    useWebWorker: true,
    initialQuality: 0.82,
    fileType: 'image/jpeg',
  });
  return imageCompression.getDataUrlFromFile(compressed);
}

export default function HeroSticker() {
  const [src, setSrc] = useState<string | null>(readStored);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const custom = !!src && src !== DEFAULT_SRC;

  const pick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    setBusy(true);
    try {
      const small = await shrink(f);
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
    <figure data-testid="hero-sticker" className="relative w-36 shrink-0 rotate-2 transition-transform hover:rotate-0 motion-reduce:transition-none motion-reduce:hover:rotate-2">
      <Attachment orientation="vertical" className="w-full bg-card shadow-sm">
        <AttachmentMedia variant="icon" className="aspect-square w-full">
          <img
            src={src ?? DEFAULT_SRC}
            alt="maharness 品牌贴纸"
            className={cn('size-full', custom ? 'object-cover' : 'bg-[#fff8ed] object-contain p-3')}
          />
          <AttachmentTrigger onClick={pick} disabled={busy} title="点击换一张图片" aria-label="更换首页贴纸照片" />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1 bg-primary/90 p-1 text-[11px] text-primary-foreground opacity-0 transition-opacity group-hover/attachment:opacity-100">
            {busy ? <><Spinner className="size-3" />处理中…</> : <>换一张 <Camera size={12} /></>}
          </span>
        </AttachmentMedia>
        <AttachmentContent className="text-center">
          <AttachmentTitle>{custom ? '我拍的贴纸' : '今日贴纸'}</AttachmentTitle>
          <AttachmentDescription>{custom ? '点击照片可再换' : '点击照片换一张'}</AttachmentDescription>
        </AttachmentContent>
        {custom && (
          <AttachmentActions>
            <AttachmentAction onClick={reset} title="恢复默认" aria-label="恢复默认贴纸"><RotateCcw /></AttachmentAction>
          </AttachmentActions>
        )}
      </Attachment>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} hidden aria-hidden="true" />
    </figure>
  );
}
