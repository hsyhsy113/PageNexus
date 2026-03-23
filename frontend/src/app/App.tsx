import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BookOpenText,
  Bot,
  Cpu,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Settings,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { PiAgentInterface } from "../components/PiAgentInterface";
import {
  checkModelHealth,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteDocument,
  getEffectiveStoragePath,
  getAppSettings,
  listDocuments,
  listKnowledgeBases,
  retryDocumentParse,
  saveAppSettings,
  stopCodingAgent,
  uploadPdf,
} from "../lib/api";
import { asAgent, CodingAgentSessionAdapter } from "../lib/coding-agent-session";
import { syncPiProviderKey } from "../lib/pi-storage";
import type { AppSettings, DocumentRecord, KnowledgeBase, ModelHealth } from "../lib/types";

type ViewMode = "workspace" | "settings";

const EMPTY_HEALTH: ModelHealth = {
  backend_status: "offline",
  model_status: "unavailable",
  detail: "尚未完成模型健康检查。",
};

const DEFAULT_SETTINGS: AppSettings = {
  packy_api_key: "",
  packy_api_base_url: "https://www.packyapi.com/v1",
  packy_model_id: "gpt-5.4-low",
  mineru_api_token: "",
  storage_dir: "",
  python_runtime_path: "",
};

function createTimestampLabel() {
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusTone(document: DocumentRecord) {
  switch (document.status) {
    case "parsed":
      return "text-emerald-600 bg-emerald-500/10";
    case "failed":
      return "text-rose-600 bg-rose-500/10";
    case "parsing":
      return "text-amber-700 bg-amber-500/10";
    default:
      return "text-slate-500 bg-slate-500/10";
  }
}

function GlowCard(props: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`glass-panel rounded-[2rem] ${props.className ?? ""}`}>{props.children}</div>;
}

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function App() {
  const [view, setView] = useState<ViewMode>("workspace");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [activeKbId, setActiveKbId] = useState<string | null>(null);
  const [isCreateKbOpen, setIsCreateKbOpen] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [isCreatingKb, setIsCreatingKb] = useState(false);
  const [documentsByKb, setDocumentsByKb] = useState<Record<string, DocumentRecord[]>>({});
  const [isUploading, setIsUploading] = useState(false);
  const [health, setHealth] = useState<ModelHealth>(EMPTY_HEALTH);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [storagePath, setStoragePath] = useState("");
  const [activeAgent, setActiveAgent] = useState<ReturnType<typeof asAgent> | null>(null);
  const [isBootingAgent, setIsBootingAgent] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [agentBootNonce, setAgentBootNonce] = useState(0);

  const activeKbRef = useRef<string | null>(null);
  const createKbInputRef = useRef<HTMLInputElement | null>(null);
  const activeSessionRef = useRef<CodingAgentSessionAdapter | null>(null);

  const activeKb = useMemo(
    () => knowledgeBases.find((knowledgeBase) => knowledgeBase.id === activeKbId) ?? null,
    [activeKbId, knowledgeBases],
  );
  const activeDocuments = activeKbId ? documentsByKb[activeKbId] ?? [] : [];

  const logDiagnostic = (message: string) => {
    setDiagnostics((previous) => [`[${createTimestampLabel()}] ${message}`, ...previous].slice(0, 120));
  };

  const refreshKnowledgeBases = async () => {
    const nextKnowledgeBases = await listKnowledgeBases();
    setKnowledgeBases(nextKnowledgeBases);
    if (!activeKbRef.current && nextKnowledgeBases.length > 0) {
      setActiveKbId(nextKnowledgeBases[0].id);
    }
  };

  const refreshDocuments = async (kbId: string) => {
    const documents = await listDocuments(kbId);
    setDocumentsByKb((previous) => ({ ...previous, [kbId]: documents }));
    return documents;
  };

  const refreshHealth = async () => {
    try {
      const modelHealth = await checkModelHealth();
      setHealth(modelHealth);
      logDiagnostic(modelHealth.detail);
    } catch (error) {
      logDiagnostic(`健康检查失败：${String(error)}`);
    }
  };

  useEffect(() => {
    activeKbRef.current = activeKbId;
  }, [activeKbId]);

  useEffect(() => {
    if (!isCreateKbOpen) return;
    createKbInputRef.current?.focus();
  }, [isCreateKbOpen]);

  useEffect(() => {
    void (async () => {
      setStoragePath(await getEffectiveStoragePath());
      const nextSettings = await getAppSettings();
      setSettings(nextSettings);
      await syncPiProviderKey(nextSettings.packy_api_key);
      await Promise.all([refreshKnowledgeBases(), refreshHealth()]);
    })();
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenPromise: Promise<() => void> | undefined;

    unlistenPromise = listen<{ kbId: string; payload: any }>("coding-agent-event", (event) => {
      if (event.payload?.kbId !== activeKbRef.current) {
        return;
      }

      const payload = event.payload?.payload;
      if (payload?.type === "stderr" && payload?.line) {
        logDiagnostic(`Agent stderr: ${payload.line}`);
      }
      if (payload?.type === "process_exit") {
        logDiagnostic("pi coding agent 已退出。");
      }
      if (payload?.type === "response" && payload?.success === false && payload?.error) {
        logDiagnostic(`Agent 错误：${payload.error}`);
      }
    });

    return () => {
      if (disposed) return;
      disposed = true;
      void unlistenPromise?.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenPromise: Promise<() => void> | undefined;

    unlistenPromise = listen<{ kbId: string; docId: string; message: string }>("parser-log", (event) => {
      if (event.payload?.kbId !== activeKbRef.current) {
        return;
      }
      logDiagnostic(`Parser: ${event.payload.message}`);
    });

    return () => {
      if (disposed) return;
      disposed = true;
      void unlistenPromise?.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootAgent = async () => {
      const previousSession = activeSessionRef.current;
      activeSessionRef.current = null;
      setActiveAgent(null);

      if (previousSession) {
        await previousSession.dispose().catch(() => undefined);
      }

      if (!activeKbId) {
        return;
      }

      setIsBootingAgent(true);

      try {
        await refreshDocuments(activeKbId);
        const session = await CodingAgentSessionAdapter.create(activeKbId);

        session.subscribe((event) => {
          if (activeKbRef.current !== activeKbId) {
            return;
          }

          if (event.type === "tool_execution_start") {
            logDiagnostic(`工具开始：${event.toolName}`);
          }
          if (event.type === "tool_execution_end") {
            logDiagnostic(`${event.isError ? "工具失败" : "工具完成"}：${event.toolName}`);
          }
        });

        if (cancelled) {
          await session.dispose().catch(() => undefined);
          return;
        }

        activeSessionRef.current = session;
        setActiveAgent(asAgent(session));
        logDiagnostic("pi coding agent 已连接。");
      } catch (error) {
        logDiagnostic(`启动知识库 Agent 失败：${String(error)}`);
      } finally {
        if (!cancelled) {
          setIsBootingAgent(false);
        }
      }
    };

    void bootAgent();

    return () => {
      cancelled = true;
    };
  }, [activeKbId, agentBootNonce]);

  useEffect(() => {
    return () => {
      const session = activeSessionRef.current;
      activeSessionRef.current = null;
      if (session) {
        void session.dispose().catch(() => undefined);
      }
    };
  }, []);

  const handleCreateKnowledgeBase = async () => {
    const name = newKbName.trim();
    if (!name) {
      logDiagnostic("请输入知识库名称。");
      return;
    }

    setIsCreatingKb(true);
    try {
      const knowledgeBase = await createKnowledgeBase(name);
      setKnowledgeBases((previous) => [knowledgeBase, ...previous]);
      setActiveKbId(knowledgeBase.id);
      setNewKbName("");
      setIsCreateKbOpen(false);
      logDiagnostic(`已创建知识库：${knowledgeBase.name}`);
    } catch (error) {
      logDiagnostic(`创建知识库失败：${String(error)}`);
    } finally {
      setIsCreatingKb(false);
    }
  };

  const handleUpload = async () => {
    if (!activeKbId) {
      logDiagnostic("请先创建或选择一个知识库。");
      return;
    }

    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: ["pdf", "doc", "docx", "ppt", "pptx", "png", "jpg", "jpeg", "html"],
        },
      ],
    });

    if (!selected || Array.isArray(selected)) return;

    setIsUploading(true);
    const optimisticDocument: DocumentRecord = {
      id: `uploading-${Date.now()}`,
      kb_id: activeKbId,
      file_name: fileNameFromPath(selected),
      source_path: selected,
      page_count: 0,
      status: "parsing",
      error_message: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setDocumentsByKb((previous) => ({
      ...previous,
      [activeKbId]: [optimisticDocument, ...(previous[activeKbId] ?? [])],
    }));

    try {
      const document = await uploadPdf(activeKbId, selected);
      await refreshDocuments(activeKbId);
      logDiagnostic(`MinerU 解析完成：${document.file_name} (${document.status})`);
    } catch (error) {
      setDocumentsByKb((previous) => ({
        ...previous,
        [activeKbId]: (previous[activeKbId] ?? []).filter((document) => document.id !== optimisticDocument.id),
      }));
      logDiagnostic(`上传失败：${String(error)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    const confirmed = await confirm("确认删除这份文档及其解析结果？", {
      title: "删除文档",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await deleteDocument(documentId);
      if (activeKbId) {
        await refreshDocuments(activeKbId);
      }
      logDiagnostic(`已删除文档 ${documentId}`);
    } catch (error) {
      logDiagnostic(`删除文档失败：${String(error)}`);
    }
  };

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      const nextSettings = {
        packy_api_key: settings.packy_api_key.trim(),
        packy_api_base_url: settings.packy_api_base_url.trim() || DEFAULT_SETTINGS.packy_api_base_url,
        packy_model_id: settings.packy_model_id.trim() || DEFAULT_SETTINGS.packy_model_id,
        mineru_api_token: settings.mineru_api_token.trim(),
        storage_dir: settings.storage_dir.trim(),
        python_runtime_path: settings.python_runtime_path.trim(),
      };
      const previousStoragePath = storagePath;
      await saveAppSettings(nextSettings);
      setSettings(nextSettings);
      await syncPiProviderKey(nextSettings.packy_api_key);

      if (activeSessionRef.current) {
        await activeSessionRef.current.dispose().catch(() => undefined);
        activeSessionRef.current = null;
      }
      setActiveAgent(null);
      if (activeKbId) {
        await stopCodingAgent(activeKbId).catch(() => undefined);
      }

      setAgentBootNonce((value) => value + 1);
      await refreshHealth();
      if (nextSettings.storage_dir && nextSettings.storage_dir !== previousStoragePath) {
        logDiagnostic("存储目录已保存，重启应用后生效。");
      }
      logDiagnostic("模型设置已保存。");
    } catch (error) {
      logDiagnostic(`保存设置失败：${String(error)}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleRetryDocument = async (documentId: string) => {
    if (!activeKbId) return;
    try {
      setDocumentsByKb((previous) => ({
        ...previous,
        [activeKbId]: (previous[activeKbId] ?? []).map((document) =>
          document.id === documentId
            ? { ...document, status: "parsing", error_message: null, updated_at: new Date().toISOString() }
            : document,
        ),
      }));
      const nextDocument = await retryDocumentParse(documentId);
      await refreshDocuments(activeKbId);
      logDiagnostic(`重试解析完成：${nextDocument.file_name} (${nextDocument.status})`);
    } catch (error) {
      await refreshDocuments(activeKbId);
      logDiagnostic(`重试解析失败：${String(error)}`);
    }
  };

  const handleDeleteKnowledgeBase = async (kbId: string, kbName: string) => {
    const confirmed = await confirm(`确认删除知识库「${kbName}」及其全部文档和会话？`, {
      title: "删除知识库",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await deleteKnowledgeBase(kbId);
      setDocumentsByKb((previous) => {
        const next = { ...previous };
        delete next[kbId];
        return next;
      });
      if (activeKbId === kbId) {
        const remaining = knowledgeBases.filter((item) => item.id !== kbId);
        setActiveKbId(remaining.length > 0 ? remaining[0].id : null);
      }
      await refreshKnowledgeBases();
      logDiagnostic(`已删除知识库：${kbName}`);
    } catch (error) {
      logDiagnostic(`删除知识库失败：${String(error)}`);
    }
  };

  const handlePickStorageDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: settings.storage_dir.trim() || storagePath,
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    setSettings((current) => ({ ...current, storage_dir: selected }));
  };

  return (
    <div className="min-h-screen overflow-hidden text-slate-800">
      <div className="pointer-events-none fixed inset-0 opacity-70">
        <div className="absolute left-[8%] top-[-8%] h-[34rem] w-[34rem] rounded-full bg-emerald-200/45 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[3%] h-[26rem] w-[26rem] rounded-full bg-amber-100/60 blur-[130px]" />
      </div>

      <div className="relative z-10 flex h-screen gap-4 p-4">
        <aside className="glass-panel flex w-[18rem] shrink-0 flex-col rounded-[2.5rem] p-6">
          <div className="mb-10 px-2">
            <div className="text-3xl font-black italic tracking-[-0.08em] text-slate-900">PageNexus.</div>
            <div className="mt-2 text-[10px] font-black uppercase tracking-[0.28em] text-slate-400">
              Desktop Knowledge Base
            </div>
          </div>

          <div className="mb-4 px-3 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">
            Knowledge Bases
          </div>
          <div className="soft-scrollbar flex-1 space-y-3 overflow-y-auto pr-1">
            {knowledgeBases.map((knowledgeBase) => {
              const active = knowledgeBase.id === activeKbId && view === "workspace";
              return (
                <div
                  key={knowledgeBase.id}
                  className={`w-full rounded-[1.8rem] px-4 py-4 text-left transition-all ${
                    active ? "bg-white shadow-lg shadow-emerald-900/10 ring-1 ring-emerald-100" : "hover:bg-white/55"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => {
                        setActiveKbId(knowledgeBase.id);
                        setView("workspace");
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-2.5 w-2.5 rounded-full ${
                            knowledgeBase.theme === "green"
                              ? "bg-emerald-400"
                              : knowledgeBase.theme === "yellow"
                                ? "bg-amber-400"
                                : knowledgeBase.theme === "blue"
                                  ? "bg-sky-400"
                                  : "bg-rose-400"
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-black text-slate-900">{knowledgeBase.name}</div>
                          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                            {(documentsByKb[knowledgeBase.id] ?? []).length} docs
                          </div>
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => void handleDeleteKnowledgeBase(knowledgeBase.id, knowledgeBase.name)}
                      className="rounded-full p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                      title="删除知识库"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={() => {
              setIsCreateKbOpen((previous) => !previous);
              setNewKbName("");
            }}
            className="mt-4 flex items-center gap-3 rounded-[1.6rem] px-4 py-4 text-sm font-black text-emerald-700 transition-colors hover:bg-emerald-50/80"
          >
            <Plus className="h-4 w-4" />
            新建知识库
          </button>

          {isCreateKbOpen ? (
            <div className="mt-3 rounded-[1.8rem] bg-white/75 p-4 shadow-sm ring-1 ring-white/80">
              <div className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">Create KB</div>
              <input
                ref={createKbInputRef}
                value={newKbName}
                onChange={(event) => setNewKbName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleCreateKnowledgeBase();
                  }
                  if (event.key === "Escape") {
                    setIsCreateKbOpen(false);
                    setNewKbName("");
                  }
                }}
                placeholder="例如：澳洲地产法"
                className="mt-3 w-full rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-bold text-slate-800 outline-none transition focus:border-emerald-300"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void handleCreateKnowledgeBase()}
                  disabled={!newKbName.trim() || isCreatingKb}
                  className="flex-1 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                >
                  {isCreatingKb ? "创建中..." : "创建"}
                </button>
                <button
                  onClick={() => {
                    setIsCreateKbOpen(false);
                    setNewKbName("");
                  }}
                  className="rounded-2xl px-4 py-3 text-sm font-black text-slate-500 transition hover:bg-slate-100"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-6 border-t border-white/60 pt-6">
            <button
              onClick={() => setView("settings")}
              className={`flex w-full items-center gap-3 rounded-[1.6rem] px-4 py-4 text-sm font-black transition-all ${
                view === "settings" ? "bg-slate-900 text-white shadow-lg" : "text-slate-500 hover:bg-white/60"
              }`}
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="glass-panel mb-4 flex h-11 items-center justify-between rounded-[1.8rem] px-8">
            <div className="flex items-center gap-6 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    health.backend_status === "online" ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                Backend: {health.backend_status}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    health.model_status === "ready" ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                Model: {health.model_status}
              </div>
            </div>
            <div className="flex items-center gap-5 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400">
              <div className="flex items-center gap-1">
                <Bot className="h-3.5 w-3.5" />
                pi-coding-agent
              </div>
              <div className="flex items-center gap-1">
                <Cpu className="h-3.5 w-3.5" />
                {settings.packy_model_id || DEFAULT_SETTINGS.packy_model_id}
              </div>
              <div className="flex items-center gap-1">
                <Activity className="h-3.5 w-3.5" />
                {health.detail}
              </div>
            </div>
          </div>

          {view === "workspace" ? (
            <div className="flex min-h-0 flex-1 gap-4">
              <div className="flex w-[20rem] shrink-0 flex-col gap-4">
                <GlowCard className="flex min-h-0 flex-1 flex-col p-4">
                  <div className="mb-5 flex items-center justify-between px-3 pt-3">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.28em] text-slate-400">Library</div>
                      <div className="mt-2 text-xs font-black text-slate-900">{activeKb?.name ?? "No KB"}</div>
                    </div>
                    <button
                      onClick={handleUpload}
                      disabled={isUploading || !activeKbId}
                      className="rounded-2xl bg-emerald-50 p-3 text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                    >
                      <Upload className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="soft-scrollbar flex-1 space-y-2 overflow-y-auto pr-1">
                    {activeDocuments.map((document) => (
                      <div key={document.id} className="rounded-[1.8rem] border border-transparent p-4 transition-all hover:bg-white/50">
                        <div className="flex items-start gap-3">
                          <div
                            className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
                              document.status === "parsed"
                                ? "bg-emerald-500 text-white shadow-lg shadow-emerald-200"
                                : document.status === "parsing" || document.status === "queued"
                                  ? "bg-amber-100 text-amber-700"
                                : "bg-slate-100 text-slate-400"
                            }`}
                          >
                            {document.status === "parsing" || document.status === "queued" ? (
                              <LoaderCircle className="h-5 w-5 animate-spin" />
                            ) : (
                              <FileText className="h-5 w-5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-black text-slate-900">{document.file_name}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] ${statusTone(document)}`}
                              >
                                {document.status}
                              </span>
                              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                                {document.page_count} p
                              </span>
                            </div>
                            {document.error_message ? (
                              <div className="mt-2 text-[11px] leading-5 text-rose-600">{document.error_message}</div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1">
                            {document.status === "failed" ? (
                              <button
                                onClick={() => void handleRetryDocument(document.id)}
                                className="rounded-full p-2 text-slate-400 transition-colors hover:bg-amber-50 hover:text-amber-600"
                                title="重试解析"
                              >
                                <RefreshCcw className="h-4 w-4" />
                              </button>
                            ) : null}
                            <button
                              onClick={() => void handleDeleteDocument(document.id)}
                              className="rounded-full p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {activeDocuments.length === 0 ? (
                      <div className="rounded-[1.8rem] border border-dashed border-white/80 bg-white/35 px-5 py-8 text-center">
                        <BookOpenText className="mx-auto h-10 w-10 text-slate-300" />
                        <div className="mt-4 text-sm font-black text-slate-600">还没有文档</div>
                        <div className="mt-2 text-xs leading-6 text-slate-400">
                          上传文档后，PageNexus 会用 MinerU 精准解析，再把合并后的结构结果交给 Agent 做原生检索。
                        </div>
                      </div>
                    ) : null}
                  </div>
                </GlowCard>
              </div>

              <GlowCard className="relative min-w-0 flex-1 overflow-hidden p-0">
                {!activeKb ? (
                  <div className="flex h-full items-center justify-center p-10">
                    <div className="max-w-xl rounded-[2.4rem] bg-white/70 p-10 shadow-sm">
                      <div className="flex items-center gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="text-[10px] font-black uppercase tracking-[0.28em] text-slate-400">
                            Nexus Native Retrieval
                          </div>
                          <div className="mt-2 text-base font-black text-slate-900">先创建一个知识库</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : isBootingAgent ? (
                  <div className="flex h-full items-center justify-center p-10">
                    <div className="rounded-[2rem] bg-white/75 px-8 py-6 text-sm font-black text-slate-600 shadow-sm">
                      正在连接 pi coding agent...
                    </div>
                  </div>
                ) : activeAgent ? (
                  <div className="agent-shell h-full px-4 py-4">
                    <PiAgentInterface session={activeAgent} />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center p-10">
                    <div className="rounded-[2rem] bg-white/75 px-8 py-6 text-sm font-black text-rose-500 shadow-sm">
                      Agent 未启动，请查看设置页诊断日志。
                    </div>
                  </div>
                )}
              </GlowCard>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-4">
              <GlowCard className="min-h-0 p-8">
                <div className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Environment</div>
                <div className="mt-6 space-y-5 text-sm text-slate-600">
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Storage</div>
                    <input
                      value={settings.storage_dir}
                      onChange={(event) => setSettings((current) => ({ ...current, storage_dir: event.target.value }))}
                      placeholder={`留空使用默认目录：${storagePath}`}
                      className="mt-3 w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-medium outline-none transition focus:border-emerald-300"
                    />
                    <button
                      onClick={() => void handlePickStorageDir()}
                      className="mt-3 inline-flex items-center gap-2 rounded-2xl bg-white/80 px-4 py-3 text-sm font-black text-slate-700 ring-1 ring-white/70"
                    >
                      <FolderOpen className="h-4 w-4" />
                      选择文件夹
                    </button>
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Model</div>
                    <div className="mt-2 space-y-3">
                      <input
                        value={settings.packy_api_base_url}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, packy_api_base_url: event.target.value }))
                        }
                        placeholder="API Base URL"
                        className="w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-medium outline-none transition focus:border-emerald-300"
                      />
                      <input
                        value={settings.packy_model_id}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, packy_model_id: event.target.value }))
                        }
                        placeholder="Model ID"
                        className="w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-medium outline-none transition focus:border-emerald-300"
                      />
                      <textarea
                        value={settings.packy_api_key}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, packy_api_key: event.target.value }))
                        }
                        placeholder="PackyAPI API Key"
                        rows={4}
                        className="w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-mono text-xs outline-none transition focus:border-emerald-300"
                      />
                      <textarea
                        value={settings.mineru_api_token}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, mineru_api_token: event.target.value }))
                        }
                        placeholder="MinerU API Token"
                        rows={4}
                        className="w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-mono text-xs outline-none transition focus:border-emerald-300"
                      />
                      <input
                        value={settings.python_runtime_path}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, python_runtime_path: event.target.value }))
                        }
                        placeholder="Python Runtime Path (optional)"
                        className="w-full rounded-2xl border border-emerald-100 bg-white/70 px-4 py-4 font-medium outline-none transition focus:border-emerald-300"
                      />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Runtime</div>
                    <div className="mt-2 rounded-2xl bg-white/70 px-4 py-4 font-medium">
                      Parser: Python splitter + MinerU precise parse + shared Python runtime for agent/tools
                    </div>
                  </div>
                  <button
                    onClick={() => void handleSaveSettings()}
                    disabled={isSavingSettings}
                    className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    <Settings className="h-4 w-4" />
                    {isSavingSettings ? "保存中..." : "保存设置"}
                  </button>
                  <button
                    onClick={() => void refreshHealth()}
                    className="inline-flex items-center gap-2 rounded-2xl bg-white/80 px-4 py-3 text-sm font-black text-slate-700 ring-1 ring-white/70"
                  >
                    <RefreshCcw className="h-4 w-4" />
                    重新健康检查
                  </button>
                </div>
              </GlowCard>

              <GlowCard className="min-h-0 p-8">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Diagnostics</div>
                  <TriangleAlert className="h-4 w-4 text-slate-400" />
                </div>
                <div className="soft-scrollbar mt-6 h-[calc(100%-2.5rem)] space-y-3 overflow-y-auto pr-2">
                  {diagnostics.length === 0 ? (
                    <div className="rounded-[1.8rem] bg-white/60 px-5 py-5 text-sm text-slate-400">暂无日志。</div>
                  ) : (
                    diagnostics.map((entry) => (
                      <div key={entry} className="rounded-[1.8rem] bg-white/60 px-5 py-4 text-sm leading-7 text-slate-600">
                        {entry}
                      </div>
                    ))
                  )}
                </div>
              </GlowCard>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
