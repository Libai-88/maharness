import { materialApi, type Material, type MaterialRef } from '../material-api';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commandsApi } from '../api';
import type { ChatMessage, CommandInfo } from '../types';
import { AGENT_NAME } from '../voice';

interface Options {
  onSend: (text: string, materials?: MaterialRef[]) => void;
  onStop: () => void;
  streaming: boolean;
  sessionKey?: string;
  pendingInference?: { objective: string; rationale: string; confidence: number } | null;
}

export type ChatComposerController = ReturnType<typeof useChatComposer>;

export function useChatComposer({
  onSend,
  onStop,
  streaming,
  sessionKey,
  pendingInference,
}: Options) {
  const [input, setInput] = useState('');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setMaterials([]); }, [sessionKey]);
  const addMaterial = useCallback((material: Material, quote?: string) => {
    setMaterials(previous => previous.some(item => item.id === material.id) ? previous : previous.length < 10 ? [...previous, material] : previous);
    if (quote) setInput(previous => `${previous}${previous ? '\n\n' : ''}引用资料：\n${quote}`);
  }, []);
  const uploadFiles = useCallback(async (files: File[]) => {
    if (uploadLock.current || !sessionKey) return;
    if (files.length + materials.length > 10) { toast.error('单次任务最多附加 10 个文件'); return; }
    uploadLock.current = true; setUploading(true); const current = generation.current;
    try { for (const file of files) { const material = await materialApi.upload(file); if (generation.current === current) addMaterial(material); } }
    catch (error) { toast.error(String(error)); }
    finally { uploadLock.current = false; setUploading(false); }
  }, [sessionKey, materials.length, addMaterial]);
  const [inferenceAcceptance, setInferenceAcceptance] = useState('');
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [quote, setQuote] = useState<{ author: string; text: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [inputHist, setInputHist] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const histIdxRef = useRef(-1);

  useEffect(() => {
    commandsApi.list().then((response) => setCommands(response.commands)).catch(() => undefined);
  }, []);

  useEffect(() => {
    setQuote(null);
    setEmojiOpen(false);
  }, [sessionKey]);

  useEffect(() => {
    if (!pendingInference) setInferenceAcceptance('');
  }, [pendingInference]);

  const matched = useMemo(
    () => input.startsWith('/')
      ? commands.filter((command) => {
        const query = input.slice(1).toLowerCase();
        return !query || command.name.startsWith(query) || query.startsWith(command.name);
      })
      : [],
    [commands, input],
  );

  const submit = useCallback((textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || streaming || uploading || !sessionKey) return;
    const full = quote ? `【引用 ${quote.author}】\n${quote.text}\n\n${text}` : text;
    if (textOverride === undefined && text) {
      setInputHist((previous) => [text, ...previous].slice(0, 30));
      histIdxRef.current = -1;
    }
    setInput('');
    setQuote(null);
    setCmdOpen(false);
    setEmojiOpen(false);
    onSend(full, materials.map(({ id, version }) => ({ id, version })));
    setMaterials([]);
  }, [input, onSend, quote, streaming, sessionKey, materials, uploading]);

  const quoteMessage = useCallback((message: ChatMessage) => {
    setQuote({
      author: message.role === 'user' ? '你' : AGENT_NAME,
      text: message.content.slice(0, 400),
    });
    inputRef.current?.focus();
  }, []);

  const applyCommand = useCallback((command: CommandInfo, execute = true) => {
    if (command.usage) {
      setInput(`/${command.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    } else if (execute) {
      setInput(`/${command.name}`);
      submit(`/${command.name}`);
    } else {
      setInput(`/${command.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    }
  }, [submit]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (cmdOpen && matched.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCmdIdx((index) => (index + 1) % matched.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCmdIdx((index) => (index - 1 + matched.length) % matched.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCmdOpen(false);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        applyCommand(matched[cmdIdx], false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        applyCommand(matched[cmdIdx]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'ArrowUp' && !input && inputHist.length > 0) {
      event.preventDefault();
      histIdxRef.current = Math.min(histIdxRef.current + 1, inputHist.length - 1);
      setInput(inputHist[histIdxRef.current]);
    } else if (event.key === 'ArrowDown' && histIdxRef.current >= 0) {
      event.preventDefault();
      histIdxRef.current -= 1;
      setInput(histIdxRef.current >= 0 ? inputHist[histIdxRef.current] : '');
    }
    if (event.key === 'Escape') {
      if (emojiOpen) {
        event.preventDefault();
        setEmojiOpen(false);
        return;
      }
      if (streaming) {
        event.preventDefault();
        onStop();
      }
    }
  }, [applyCommand, cmdIdx, cmdOpen, emojiOpen, input, inputHist, matched, onStop, streaming, submit]);

  return {
    canSubmit: !!sessionKey && !!input.trim() && !streaming && !uploading,
    materials, setMaterials, addMaterial, uploadFiles, uploading,
    input,
    setInput,
    inferenceAcceptance,
    setInferenceAcceptance,
    commands,
    cmdOpen,
    setCmdOpen,
    cmdIdx,
    setCmdIdx,
    quote,
    setQuote,
    emojiOpen,
    setEmojiOpen,
    inputRef,
    matched,
    submit,
    quoteMessage,
    applyCommand,
    onKeyDown,
  };
}
