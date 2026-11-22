import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { materialApi, type Material } from '../material-api';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfPreview({ material, initialPage = 1 }: { material: Material; initialPage?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState('');
  useEffect(() => {
    setPdf(undefined);
    setError('');
    let alive = true;
    let document: PDFDocumentProxy | undefined;
    void materialApi
      .blob(material)
      .then((blob) => blob.arrayBuffer())
      .then(async (data) => {
        const task = getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true });
        document = await task.promise;
        if (alive) {
          setPdf(document);
          setPage(Math.min(Math.max(1, initialPage), document.numPages));
        } else await document.destroy();
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
      void document?.destroy();
    };
  }, [material.id, material.version, initialPage]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    void pdf
      .getPage(page)
      .then((item) => {
        if (!alive || !canvas.current) return;
        const viewport = item.getViewport({ scale: 1.25 });
        const element = canvas.current;
        element.width = viewport.width;
        element.height = viewport.height;
        const context = element.getContext('2d');
        if (!context) return;
        const task = item.render({ canvasContext: context, viewport });
        cancel = () => task.cancel();
        return task.promise;
      })
      .catch((error) => {
        if (alive && error?.name !== 'RenderingCancelledException') setError(String(error));
      });
    return () => {
      alive = false;
      cancel?.();
    };
  }, [pdf, page]);
  return (
    <section className="flex flex-col items-center gap-3" aria-label="PDF 原页预览">
      {error && <p role="alert">{error}</p>}
      {!pdf && !error && <Spinner />}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={!pdf || page <= 1} onClick={() => setPage((p) => p - 1)}>
          上一页
        </Button>
        <span aria-live="polite">
          {page} / {pdf?.numPages ?? '…'}
        </span>
        <Button variant="outline" size="sm" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </div>
      <canvas ref={canvas} className="h-auto max-w-full" aria-label={`PDF 第 ${page} 页`} />
    </section>
  );
}
