import { lazy, Suspense, useRef, useState } from 'react';
import type { ChatComposerController } from '../../hooks/useChatComposer';
import { materialApi, type Material } from '../../material-api';
import { fileApi } from '../../api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Attachment, AttachmentContent, AttachmentTitle } from '@/components/ui/attachment';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
const MaterialViewer = lazy(() => import('../MaterialViewer'));
export default function AttachmentControls({ composer }: { composer: ChatComposerController }) {
  const upload = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState('.');
  const [entries, setEntries] = useState<{ name: string; type: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<Material>();
  const [busy, setBusy] = useState(false);
  const list = async (path: string) => {
    setBusy(true);
    try {
      const tree = await fileApi.tree(path);
      setEntries(tree.entries);
      setDirectory(path);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-2" aria-label="任务附件">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={upload}
          type="file"
          multiple
          className="sr-only"
          aria-label="上传任务文件"
          onChange={(event) => {
            void composer.uploadFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={composer.uploading || composer.materials.length >= 10}
          onClick={() => upload.current?.click()}
        >
          {composer.uploading ? <Spinner /> : null}添加文件
        </Button>
        <Popover
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (value) void list('.');
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" disabled={composer.materials.length >= 10}>
              选择工作区文件
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex max-h-80 w-80 flex-col gap-2 overflow-auto">
            <p className="break-all text-xs text-muted-foreground">{directory}</p>
            {directory !== '.' && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void list(directory.split('/').slice(0, -1).join('/') || '.')}>
                上一级
              </Button>
            )}
            {busy && <Spinner />}
            {entries.map((entry) => (
              <Button
                key={entry.name}
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
                  if (entry.type === 'dir') void list(path);
                  else
                    void materialApi
                      .register(path)
                      .then((material) => {
                        composer.addMaterial(material);
                        setOpen(false);
                      })
                      .catch((error) => toast.error(String(error)));
                }}
              >
                {entry.type === 'dir' ? '📁 ' : '📄 '}
                {entry.name}
              </Button>
            ))}
            {!entries.length && !busy && <p className="text-sm text-muted-foreground">此目录没有文件</p>}
          </PopoverContent>
        </Popover>
        <span className="text-xs text-muted-foreground">可拖入文件 · 单个 ≤20 MB · 最多 10 个</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {composer.materials.map((material) => (
          <Attachment key={material.id} size="sm">
            <AttachmentContent>
              <AttachmentTitle>
                <Button type="button" variant="link" size="sm" onClick={() => setViewing(material)}>
                  {material.name}
                </Button>
              </AttachmentTitle>
            </AttachmentContent>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`移除附件 ${material.name}`}
              onClick={() => composer.setMaterials((previous) => previous.filter((item) => item.id !== material.id))}
            >
              移除
            </Button>
          </Attachment>
        ))}
      </div>
      <Dialog
        open={Boolean(viewing)}
        onOpenChange={(value) => {
          if (!value) setViewing(undefined);
        }}
      >
        <DialogContent className="flex h-[85dvh] max-w-5xl flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name ?? '文件预览'}</DialogTitle>
          </DialogHeader>
          {viewing && (
            <Suspense fallback={<Spinner />}>
              <MaterialViewer material={viewing} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
