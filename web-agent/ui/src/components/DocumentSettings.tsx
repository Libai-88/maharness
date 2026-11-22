import { useEffect, useState } from 'react';
import { materialApi, type MaterialCapabilities } from '../material-api';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
export default function DocumentSettings() {
  const [state, setState] = useState<MaterialCapabilities>();
  const [error, setError] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('["{file}","stdout"]');
  const [pdfCommand, setPdfCommand] = useState('');
  const [pdfArgs, setPdfArgs] = useState('["-png","-r","150","{input}","{outDir}/page"]');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const value = await materialApi.capabilities();
    if (!value?.ocr?.config) throw new Error('文件处理状态暂不可用，请刷新后重试');
    const config = value.ocr.config;
    setState(value);
    setCommand(config.command ?? '');
    setPdfCommand(config.pdfCommand ?? '');
    if (config.args) setArgs(JSON.stringify(config.args));
    if (config.pdfArgs) setPdfArgs(JSON.stringify(config.pdfArgs));
    setError('');
  };
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      const imageArgs: unknown = JSON.parse(args),
        renderArgs: unknown = JSON.parse(pdfArgs);
      if (
        !Array.isArray(imageArgs) ||
        !Array.isArray(renderArgs) ||
        [...imageArgs, ...renderArgs].some((value) => typeof value !== 'string')
      )
        throw new Error('参数应为字符串组成的 JSON 数组');
      await materialApi.configureOcr({ command, pdfCommand, args: imageArgs, pdfArgs: renderArgs });
      await load();
      toast.success('OCR 配置已保存；首次使用请试识别确认引擎可运行');
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>文件与资料处理</CardTitle>
        <CardDescription>文件处理与联网能力状态；OCR 需要本机已经安装的外部引擎。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">文档：{state ? (state.document ? '可用' : '插件未启用') : '检测中'}</Badge>
          <Badge variant="secondary">联网搜索：{state ? (state.search ? '已启用' : '未启用') : '检测中'}</Badge>
          <Badge variant="outline">图片 OCR：{state?.ocr.image ? '已配置，待实际识别确认' : '未配置'}</Badge>
          <Badge variant="outline">扫描 PDF：{state?.ocr.pdf ? '已配置，待实际识别确认' : '未配置'}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          导入副本保存到当前工作区 imports/，生成文件保存到 outputs/任务ID/。Office 为内容预览，复杂格式有支持边界。
        </p>
        <details>
          <summary>配置可选 OCR</summary>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="ocr-command">图片识别命令</FieldLabel>
                <Input
                  id="ocr-command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="本机 OCR 可执行文件路径"
                />
                <FieldDescription>命令需将识别文本输出到标准输出；不会自动下载或安装引擎。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="ocr-args">图片命令参数（JSON 数组）</FieldLabel>
                <Input id="ocr-args" value={args} onChange={(event) => setArgs(event.target.value)} />
                <FieldDescription>{'{file} 替换为图片路径'}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="ocr-pdf-command">PDF 页面渲染命令</FieldLabel>
                <Input id="ocr-pdf-command" value={pdfCommand} onChange={(event) => setPdfCommand(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="ocr-pdf-args">渲染参数（JSON 数组）</FieldLabel>
                <Input id="ocr-pdf-args" value={pdfArgs} onChange={(event) => setPdfArgs(event.target.value)} />
                <FieldDescription>{'{input} 为 PDF 路径，{outDir} 为临时输出目录'}</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={busy} className="self-start">
              保存 OCR 配置
            </Button>
            <p className="text-xs text-muted-foreground">
              试识别：在聊天中添加一张图片或扫描 PDF，输入“识别这个文件中的文字”。执行失败时会显示命令、文件或引擎问题。
            </p>
          </form>
        </details>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
