import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { InputRef } from "antd";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
<<<<<<< HEAD
=======
  Activity,
  ArrowLeft,
  BookOpenText,
  Bot,
  ChevronRight,
  Cpu,
  FileText,
  FolderOpen,
  Globe,
  Key,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCcw,
  Settings,
  Square,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { PiAgentInterface } from "../components/PiAgentInterface";
import {
>>>>>>> 2acaeee (add embedding semantic search)
  checkModelHealth,
  cancelDocumentParse,
  createKnowledgeBase,
  deleteCodingAgentSession,
  deleteDocument,
  deleteKnowledgeBase,
  getAppSettings,
  getDocumentMarkdown,
  getEffectiveStoragePath,
  listDocuments,
  listKnowledgeBases,
  retryDocumentParse,
  saveAppSettings,
  setCodingAgentSession,
  stopCodingAgent,
  uploadPdf,
} from "../lib/api";
import { asAgent, CodingAgentSessionAdapter } from "../lib/coding-agent-session";
import { syncPiProviderKey } from "../lib/pi-storage";
import type { AppSettings, DocumentRecord, KnowledgeBase, ModelHealth } from "../lib/types";
import { CanvasView, CreateWorkspaceModal, DashboardView, SettingsView } from "./views";

type ViewMode = "dashboard" | "canvas" | "settings";

type WorkspaceSession = {
  id: string;
  kbId: string;
  title: string;
};

const EMPTY_HEALTH: ModelHealth = {
  backend_status: "offline",
  model_status: "unavailable",
  detail: "尚未完成模型健康检查。",
};

const DEFAULT_SETTINGS: AppSettings = {
  packy_api_key: "",
  packy_api_base_url: "https://www.packyapi.com/v1",
  packy_model_id: "gpt-5.4-low",
  semantic_search_enabled: true,
  embedding_mode: "",
  embedding_api_key: "",
  embedding_api_base_url: "https://www.packyapi.com/v1",
  embedding_model_id: "text-embedding-3-small",
  embedding_local_model_id: "google/embeddinggemma-300m",
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

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function App() {
  const [view, setView] = useState<ViewMode>("dashboard");
  const [settingsReturnView, setSettingsReturnView] = useState<Exclude<ViewMode, "settings">>("dashboard");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [activeKbId, setActiveKbId] = useState<string | null>(null);
  const [documentsByKb, setDocumentsByKb] = useState<Record<string, DocumentRecord[]>>({});
  const [workspaceSessions, setWorkspaceSessions] = useState<WorkspaceSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activePreviewDocId, setActivePreviewDocId] = useState<string | null>(null);
  const [activePreviewMarkdown, setActivePreviewMarkdown] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [isCreateKbOpen, setIsCreateKbOpen] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [isCreatingKb, setIsCreatingKb] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const [health, setHealth] = useState<ModelHealth>(EMPTY_HEALTH);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [storagePath, setStoragePath] = useState("");

  const [activeAgent, setActiveAgent] = useState<ReturnType<typeof asAgent> | null>(null);
  const [isBootingAgent, setIsBootingAgent] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [agentBootNonce, setAgentBootNonce] = useState(0);
  const [semanticRebuildProgress, setSemanticRebuildProgress] = useState<{
    kbId: string;
    current: number;
    total: number;
    percent: number;
  } | null>(null);

  const activeKbRef = useRef<string | null>(null);
  const activeAgentSessionRef = useRef<{ kbId: string; sessionId: string } | null>(null);
  const isSwitchingSessionRef = useRef(false);
  const createKbInputRef = useRef<InputRef | null>(null);
  const activeSessionRef = useRef<CodingAgentSessionAdapter | null>(null);

  const activeKb = useMemo(
    () => knowledgeBases.find((knowledgeBase) => knowledgeBase.id === activeKbId) ?? null,
    [activeKbId, knowledgeBases],
  );
  const activeDocuments = activeKbId ? documentsByKb[activeKbId] ?? [] : [];
  const activePreviewDoc = useMemo(
    () => activeDocuments.find((document) => document.id === activePreviewDocId) ?? null,
    [activeDocuments, activePreviewDocId],
  );
  const canvasSessions = useMemo(
    () => workspaceSessions.filter((session) => session.kbId === activeKbId),
    [activeKbId, workspaceSessions],
  );
  const useEmbeddingApi = settings.embedding_mode.trim() === "api";

  const logDiagnostic = (message: string) => {
    setDiagnostics((previous) => [`[${createTimestampLabel()}] ${message}`, ...previous].slice(0, 120));
  };

  const refreshKnowledgeBases = async () => {
    const nextKnowledgeBases = await listKnowledgeBases();
    setKnowledgeBases(nextKnowledgeBases);
  };

  const refreshDocuments = async (kbId: string) => {
    const documents = await listDocuments(kbId);
    setDocumentsByKb((previous) => ({ ...previous, [kbId]: documents }));
    return documents;
  };

  const openDocumentPreview = async (docId: string) => {
    setActivePreviewDocId(docId);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const markdown = await getDocumentMarkdown(docId);
      setActivePreviewMarkdown(markdown);
    } catch (error) {
      setActivePreviewMarkdown("");
      setPreviewError(String(error));
    } finally {
      setPreviewLoading(false);
    }
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

  const switchAgentSession = (kbId: string, sessionId: string, force = false) => {
    const bound = activeAgentSessionRef.current;
    if (!force && bound?.kbId === kbId && bound.sessionId === sessionId) {
      return;
    }
    isSwitchingSessionRef.current = true;
    void setCodingAgentSession(kbId, sessionId)
      .then(() => {
        activeAgentSessionRef.current = { kbId, sessionId };
        isSwitchingSessionRef.current = false;
        setAgentBootNonce((value) => value + 1);
      })
      .catch((error) => {
        isSwitchingSessionRef.current = false;
        logDiagnostic(`切换会话失败：${String(error)}`);
      });
  };

  const switchAgentSessionSafely = async (kbId: string, sessionId: string, force = false) => {
    const current = activeSessionRef.current;
    if (current?.state.isStreaming) {
      logDiagnostic("检测到当前会话仍在流式输出，先停止当前输出再切换会话。");
      await current.abort().catch(() => undefined);
    }
    switchAgentSession(kbId, sessionId, force);
  };

  const ensureWorkspaceSession = (kbId: string, kbName: string) => {
    const existing = workspaceSessions.filter((session) => session.kbId === kbId);
    if (existing.length > 0) {
      const targetSessionId =
        activeSessionId && existing.some((session) => session.id === activeSessionId)
          ? activeSessionId
          : existing[0].id;
      setActiveSessionId(targetSessionId);
      switchAgentSession(kbId, targetSessionId);
      return;
    }

    const session: WorkspaceSession = {
      id: `session-${kbId}-1`,
      kbId,
      title: `${kbName} · 会话 1`,
    };
    setWorkspaceSessions((previous) => [session, ...previous]);
    setActiveSessionId(session.id);
    switchAgentSession(kbId, session.id, true);
  };

  const preloadWorkspace = (knowledgeBase: KnowledgeBase) => {
    const docs = documentsByKb[knowledgeBase.id];
    if (docs === undefined) {
      void refreshDocuments(knowledgeBase.id).catch(() => undefined);
    }
  };

  const enterWorkspace = (knowledgeBase: KnowledgeBase) => {
    setActiveKbId(knowledgeBase.id);
    activeKbRef.current = knowledgeBase.id;
    setView("canvas");
    ensureWorkspaceSession(knowledgeBase.id, knowledgeBase.name);
    preloadWorkspace(knowledgeBase);
  };

  const openSettings = () => {
    setSettingsReturnView(view === "settings" ? "dashboard" : view);
    setView("settings");
  };

  useEffect(() => {
    activeKbRef.current = activeKbId;
  }, [activeKbId]);

  useEffect(() => {
    if (!activeKbId) {
      setActivePreviewDocId(null);
      setActivePreviewMarkdown("");
      setPreviewError(null);
      return;
    }

    const docs = documentsByKb[activeKbId] ?? [];
    if (docs.length === 0) {
      setActivePreviewDocId(null);
      setActivePreviewMarkdown("");
      setPreviewError(null);
      return;
    }

    if (activePreviewDocId && docs.some((document) => document.id === activePreviewDocId)) {
      return;
    }

    const fallback = docs.find((document) => document.status === "parsed") ?? docs[0];
    void openDocumentPreview(fallback.id);
  }, [activeKbId, documentsByKb, activePreviewDocId]);

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
    const unlistenPromise = listen<{ kbId: string; payload: any }>("coding-agent-event", (event) => {
      if (event.payload?.kbId !== activeKbRef.current) return;
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
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<{ kbId: string; docId: string; message: string }>("parser-log", (event) => {
      if (event.payload?.kbId !== activeKbRef.current) return;
      const message = String(event.payload.message ?? "");
      logDiagnostic(`Parser: ${message}`);

      const batchMatch = message.match(/\[semantic_rebuild\]\s+batch\s+(\d+)\/(\d+)\s+\((\d+)%\)/i);
      if (batchMatch) {
        const current = Number(batchMatch[1]);
        const total = Number(batchMatch[2]);
        const percent = Number(batchMatch[3]);
        if (Number.isFinite(current) && Number.isFinite(total) && Number.isFinite(percent)) {
          setSemanticRebuildProgress({
            kbId: event.payload.kbId,
            current,
            total,
            percent,
          });
        }
        return;
      }

      if (message.includes("[semantic_rebuild] start")) {
        setSemanticRebuildProgress({
          kbId: event.payload.kbId,
          current: 0,
          total: 0,
          percent: 0,
        });
        return;
      }

      if (
        message.includes("[semantic_rebuild] done") ||
        message.includes("知识库 embedding 索引重建完成") ||
        message.includes("知识库 embedding 索引重建失败")
      ) {
        setSemanticRebuildProgress(null);
      }
    });

    return () => {
      if (disposed) return;
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
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

      if (!activeKbId) return;
      if (isSwitchingSessionRef.current) return;

      setIsBootingAgent(true);
      try {
        const session = await CodingAgentSessionAdapter.create(activeKbId);
        session.subscribe((event) => {
          if (activeKbRef.current !== activeKbId) return;
          if (event.type === "tool_execution_start") logDiagnostic(`工具开始：${event.toolName}`);
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
        if (!cancelled) setIsBootingAgent(false);
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
      if (session) void session.dispose().catch(() => undefined);
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
      setIsCreateKbOpen(false);
      setNewKbName("");
      enterWorkspace(knowledgeBase);
      logDiagnostic(`已创建知识库：${knowledgeBase.name}`);
    } catch (error) {
      logDiagnostic(`创建知识库失败：${String(error)}`);
    } finally {
      setIsCreatingKb(false);
    }
  };

  const handleCreateWorkspaceSession = () => {
    if (!activeKb) return;
    const count = workspaceSessions.filter((session) => session.kbId === activeKb.id).length + 1;
    const session: WorkspaceSession = {
      id: `session-${activeKb.id}-${Date.now()}`,
      kbId: activeKb.id,
      title: `${activeKb.name} · 会话 ${count}`,
    };
    setWorkspaceSessions((previous) => [session, ...previous]);
    setActiveSessionId(session.id);
    switchAgentSession(activeKb.id, session.id, true);
  };

  const handleDeleteWorkspaceSession = async (sessionId: string) => {
    if (!activeKbId) return;
    const target = workspaceSessions.find((session) => session.id === sessionId && session.kbId === activeKbId);
    if (!target) return;

    const confirmed = await confirm(`确认删除会话「${target.title}」？`, {
      title: "删除会话",
      kind: "warning",
    });
    if (!confirmed) return;

    try {
      await deleteCodingAgentSession(activeKbId, target.id);

      const remaining = workspaceSessions.filter((session) => !(session.kbId === activeKbId && session.id === sessionId));
      setWorkspaceSessions(remaining);

      const remainingInKb = remaining.filter((session) => session.kbId === activeKbId);
      if (remainingInKb.length > 0) {
        const next = remainingInKb[0];
        setActiveSessionId(next.id);
        await switchAgentSessionSafely(activeKbId, next.id, true);
      } else {
        setActiveSessionId(null);
        activeAgentSessionRef.current = null;
      }

      logDiagnostic(`已删除会话：${target.title}`);
    } catch (error) {
      logDiagnostic(`删除会话失败：${String(error)}`);
    }
  };

  const handleUpload = async () => {
    if (!activeKbId) {
      logDiagnostic("请先创建或选择一个知识库。");
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "Documents", extensions: ["pdf", "doc", "docx", "ppt", "pptx", "png", "jpg", "jpeg", "html"] }],
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
    setDocumentsByKb((previous) => ({ ...previous, [activeKbId]: [optimisticDocument, ...(previous[activeKbId] ?? [])] }));

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
    const confirmed = await confirm("确认删除这份文档及其解析结果？", { title: "删除文档", kind: "warning" });
    if (!confirmed) return;
    try {
      await deleteDocument(documentId);
      if (activeKbId) await refreshDocuments(activeKbId);
      logDiagnostic(`已删除文档 ${documentId}`);
    } catch (error) {
      logDiagnostic(`删除文档失败：${String(error)}`);
    }
  };

  const handleRetryDocument = async (documentId: string) => {
    if (!activeKbId) return;
    try {
      setDocumentsByKb((previous) => ({
        ...previous,
        [activeKbId]: (previous[activeKbId] ?? []).map((document) =>
          document.id === documentId ? { ...document, status: "parsing", error_message: null } : document,
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

  const handleCancelDocument = async (documentId: string) => {
    if (!activeKbId) return;
    const confirmed = await confirm("确认停止当前文档解析？", { title: "停止解析", kind: "warning" });
    if (!confirmed) return;
    try {
      const nextDocument = await cancelDocumentParse(documentId);
      await refreshDocuments(activeKbId);
      logDiagnostic(`已停止解析：${nextDocument.file_name}`);
    } catch (error) {
      logDiagnostic(`停止解析失败：${String(error)}`);
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
      setKnowledgeBases((previous) => previous.filter((item) => item.id !== kbId));
      setDocumentsByKb((previous) => {
        const next = { ...previous };
        delete next[kbId];
        return next;
      });
      setWorkspaceSessions((previous) => previous.filter((session) => session.kbId !== kbId));
      if (activeKbId === kbId) {
        setActiveKbId(null);
        setActiveSessionId(null);
        setView("dashboard");
      }
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
    if (!selected || Array.isArray(selected)) return;
    setSettings((current) => ({ ...current, storage_dir: selected }));
  };

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      const nextSettings = {
        packy_api_key: settings.packy_api_key.trim(),
        packy_api_base_url: settings.packy_api_base_url.trim() || DEFAULT_SETTINGS.packy_api_base_url,
        packy_model_id: settings.packy_model_id.trim() || DEFAULT_SETTINGS.packy_model_id,
        semantic_search_enabled: settings.semantic_search_enabled,
        embedding_mode: settings.embedding_mode.trim() === "api" ? "api" : "",
        embedding_api_key: settings.embedding_api_key.trim(),
        embedding_api_base_url:
          settings.embedding_api_base_url.trim() || DEFAULT_SETTINGS.embedding_api_base_url,
        embedding_model_id: settings.embedding_model_id.trim() || DEFAULT_SETTINGS.embedding_model_id,
        embedding_local_model_id:
          settings.embedding_local_model_id.trim() || DEFAULT_SETTINGS.embedding_local_model_id,
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
      if (activeKbId) await stopCodingAgent(activeKbId).catch(() => undefined);

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

  return (
    <div className="min-h-screen overflow-hidden bg-[#f8faf7] text-slate-800">
      <div className="pointer-events-none fixed inset-0 opacity-50">
        <div className="absolute left-[10%] top-[-8%] h-[34rem] w-[34rem] rounded-full bg-emerald-200/45 blur-[160px]" />
        <div className="absolute bottom-[-10%] right-[5%] h-[28rem] w-[28rem] rounded-full bg-amber-100/60 blur-[150px]" />
      </div>

      <div className="relative z-10 flex h-screen flex-col p-4">
<<<<<<< HEAD
        {view === "dashboard" ? (
          <DashboardView
            knowledgeBases={knowledgeBases}
            documentsByKb={documentsByKb}
            onOpenSettings={openSettings}
            onEnterWorkspace={(knowledgeBase) => enterWorkspace(knowledgeBase)}
            onHoverWorkspace={(knowledgeBase) => preloadWorkspace(knowledgeBase)}
            onDeleteKnowledgeBase={(kbId, kbName) => void handleDeleteKnowledgeBase(kbId, kbName)}
            onCreateWorkspace={() => setIsCreateKbOpen(true)}
          />
=======
        {view === "dashboard" && (
          <div className="soft-scrollbar flex-1 overflow-y-auto p-6">
            <div className="mx-auto w-full max-w-6xl">
              <div className="mb-10 flex items-center justify-between">
                <div>
                  <h1 className="text-5xl font-black italic tracking-tight text-slate-900">PageNexus.</h1>
                  <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.4em] text-slate-400">Workspace Dashboard</p>
                </div>
                <button
                  onClick={openSettings}
                  className="rounded-2xl border border-white bg-white p-4 shadow-sm transition-all hover:shadow-md"
                >
                  <Settings className="h-5 w-5 text-slate-500" />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {knowledgeBases.map((knowledgeBase) => (
                  <GlowCard
                    key={knowledgeBase.id}
                    className="cursor-pointer rounded-[2.5rem] p-7 transition-all hover:-translate-y-0.5"
                  >
                    <div className="flex h-full min-h-[220px] flex-col justify-between">
                      <button
                        className="text-left"
                        onClick={() => void enterWorkspace(knowledgeBase)}
                      >
                        <div className="mb-6 flex items-center justify-between">
                          <div
                            className={`h-3 w-3 rounded-full ${
                              knowledgeBase.theme === "green"
                                ? "bg-emerald-500"
                                : knowledgeBase.theme === "yellow"
                                  ? "bg-amber-500"
                                  : knowledgeBase.theme === "blue"
                                    ? "bg-sky-500"
                                    : "bg-rose-500"
                            }`}
                          />
                          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">workspace</span>
                        </div>
                        <h3 className="line-clamp-2 text-2xl font-black italic tracking-tight text-slate-900">{knowledgeBase.name}</h3>
                        <p className="mt-3 text-xs font-semibold text-slate-500">
                          已解析 {(documentsByKb[knowledgeBase.id] ?? []).length} 份文档
                        </p>
                      </button>

                      <div className="mt-6 flex items-center justify-between">
                        <button
                          onClick={() => void handleDeleteKnowledgeBase(knowledgeBase.id, knowledgeBase.name)}
                          className="rounded-full p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => void enterWorkspace(knowledgeBase)}
                          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/70"
                        >
                          <ChevronRight className="h-5 w-5 text-slate-700" />
                        </button>
                      </div>
                    </div>
                  </GlowCard>
                ))}

                <button
                  onClick={() => setIsCreateKbOpen(true)}
                  className="flex min-h-[220px] flex-col items-center justify-center rounded-[2.5rem] border-2 border-dashed border-slate-200 bg-white/20 transition-all hover:border-emerald-400/50 hover:bg-emerald-50/30"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-[1.2rem] bg-white shadow-sm">
                    <Plus className="h-7 w-7" />
                  </div>
                  <span className="mt-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Create Workspace</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {view === "canvas" && (
          <div className="flex min-h-0 flex-1 gap-4">
            <aside className="glass-panel flex w-[20rem] shrink-0 flex-col rounded-[2.5rem] p-5">
              <button
                onClick={() => setView("dashboard")}
                className="mb-6 flex items-center justify-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white"
              >
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </button>

              <div className="mb-5 px-2">
                <div className="text-[9px] font-black uppercase tracking-[0.25em] text-slate-400">Active Space</div>
                <div className="mt-2 truncate text-sm font-black text-slate-900">{activeKb?.name ?? "No Workspace"}</div>
              </div>

              <div className="mb-4 flex items-center justify-between px-2">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Sessions</span>
                <button
                  onClick={handleCreateWorkspaceSession}
                  className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-900 hover:text-white"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="soft-scrollbar mb-6 flex-1 space-y-2 overflow-y-auto pr-1">
                {canvasSessions.map((session) => (
                  <div
                    key={session.id}
                    className={`flex items-center gap-2 rounded-[1.2rem] border px-2 py-2 transition-all ${
                      activeSessionId === session.id
                        ? "border-white bg-white text-slate-900 shadow-sm"
                        : "border-transparent text-slate-500 hover:bg-white/50"
                    }`}
                  >
                    <button
                      onClick={() => {
                        setActiveSessionId(session.id);
                        if (!activeKbId) return;
                        void switchAgentSessionSafely(activeKbId, session.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 px-1 py-1 text-left"
                    >
                      <MessageSquare className={`h-3.5 w-3.5 ${activeSessionId === session.id ? "text-emerald-500" : "opacity-50"}`} />
                      <span className="truncate text-xs font-bold">{session.title}</span>
                    </button>
                    <button
                      onClick={() => void handleDeleteWorkspaceSession(session.id)}
                      className="rounded-full p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                      title="删除会话"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {canvasSessions.length === 0 ? (
                  <div className="rounded-xl bg-white/50 px-3 py-3 text-xs text-slate-400">暂无会话。</div>
                ) : null}
              </div>

              <div className="border-t border-white/60 pt-4">
                <div className="mb-3 flex items-center justify-between px-2">
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Library</span>
                  <button
                    onClick={handleUpload}
                    disabled={isUploading || !activeKbId}
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-emerald-600 hover:text-white disabled:opacity-50"
                  >
                    {isUploading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div className="soft-scrollbar max-h-[16rem] space-y-2 overflow-y-auto pr-1">
                  {semanticRebuildProgress && semanticRebuildProgress.kbId === activeKbId ? (
                    <div className="rounded-[1rem] border border-indigo-100 bg-indigo-50/60 px-3 py-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] font-black uppercase tracking-widest text-indigo-700">Embedding Rebuild</span>
                        <span className="text-[10px] font-black text-indigo-700">
                          {semanticRebuildProgress.total > 0
                            ? `${semanticRebuildProgress.current}/${semanticRebuildProgress.total}`
                            : "starting"}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-indigo-100">
                        <div
                          className="h-full rounded-full bg-indigo-500 transition-all"
                          style={{ width: `${Math.max(2, Math.min(100, semanticRebuildProgress.percent))}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                  {activeDocuments.map((document) => (
                    <div key={document.id} className="rounded-[1rem] px-3 py-3 transition-colors hover:bg-white/50">
                      <div className="flex items-start gap-2">
                        <FileText className="mt-0.5 h-4 w-4 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-bold text-slate-700">{document.file_name}</div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${statusTone(document)}`}>
                              {document.status}
                            </span>
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{document.page_count} p</span>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {document.status === "parsing" ? (
                            <button
                              onClick={() => void handleCancelDocument(document.id)}
                              className="rounded-full p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              title="停止解析"
                            >
                              <Square className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          {document.status === "failed" ? (
                            <button
                              onClick={() => void handleRetryDocument(document.id)}
                              className="rounded-full p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600"
                            >
                              <RefreshCcw className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          <button
                            onClick={() => void handleDeleteDocument(document.id)}
                            className="rounded-full p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {activeDocuments.length === 0 ? (
                    <div className="rounded-[1rem] border border-dashed border-white/80 bg-white/35 px-4 py-6 text-center">
                      <BookOpenText className="mx-auto h-8 w-8 text-slate-300" />
                      <div className="mt-2 text-xs font-bold text-slate-500">还没有文档</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </aside>

            <GlowCard className="relative min-w-0 flex-1 overflow-hidden p-0">
              {!activeKb ? (
                <div className="flex h-full items-center justify-center p-10">
                  <div className="max-w-xl rounded-[2.4rem] bg-white/70 p-10 shadow-sm">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.28em] text-slate-400">Nexus Canvas</div>
                        <div className="mt-2 text-base font-black text-slate-900">先进入一个 Workspace</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : isBootingAgent ? (
                <div className="flex h-full items-center justify-center p-10">
                  <div className="rounded-[2rem] bg-white/75 px-8 py-6 text-sm font-black text-slate-600 shadow-sm">正在连接 pi coding agent...</div>
                </div>
              ) : activeAgent ? (
                <div className="agent-shell h-full px-4 py-4">
                  <PiAgentInterface session={activeAgent} />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-10">
                  <div className="rounded-[2rem] bg-white/75 px-8 py-6 text-sm font-black text-rose-500 shadow-sm">Agent 未启动，请查看诊断日志。</div>
                </div>
              )}
            </GlowCard>
          </div>
        )}

        {view === "settings" && (
          <div className="flex-1 overflow-y-auto rounded-[2rem] bg-white/40 p-8 backdrop-blur-3xl">
            <div className="mx-auto w-full max-w-5xl">
              <div className="mb-10 flex items-center gap-5">
                <button
                  onClick={() => setView(settingsReturnView)}
                  className="rounded-[1.2rem] border border-slate-100 bg-white p-3 shadow-sm transition-colors hover:bg-slate-50"
                >
                  <ArrowLeft className="h-5 w-5 text-slate-600" />
                </button>
                <h2 className="text-4xl font-black italic tracking-tight text-slate-900">Settings.</h2>
              </div>

              <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2">
                <GlowCard className="rounded-[2.5rem] p-8">
                  <div className="mb-7 flex items-center gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-500 text-white">
                      <Globe className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="font-black leading-none text-slate-900">Agent 模型配置</h4>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Agent Model Settings</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">API URL</label>
                      <input
                        type="text"
                        value={settings.packy_api_base_url}
                        onChange={(event) => setSettings((current) => ({ ...current, packy_api_base_url: event.target.value }))}
                        placeholder="https://www.packyapi.com/v1"
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Model Name</label>
                      <input
                        type="text"
                        value={settings.packy_model_id}
                        onChange={(event) => setSettings((current) => ({ ...current, packy_model_id: event.target.value }))}
                        placeholder="gpt-5.4-low"
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">API Key</label>
                      <input
                        type="password"
                        value={settings.packy_api_key}
                        onChange={(event) => setSettings((current) => ({ ...current, packy_api_key: event.target.value }))}
                        placeholder="sk-..."
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                  </div>
                </GlowCard>

                <GlowCard className="rounded-[2.5rem] p-8">
                  <div className="mb-7 flex items-center gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500 text-white">
                      <Cpu className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="font-black leading-none text-slate-900">Embedding 配置</h4>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Embedding Retrieval Settings</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <label className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white/50 px-4 py-3">
                      <span className="text-xs font-bold text-slate-700">启用 Semantic Search</span>
                      <input
                        type="checkbox"
                        checked={settings.semantic_search_enabled}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            semantic_search_enabled: event.target.checked,
                          }))
                        }
                        className="h-4 w-4 accent-indigo-600"
                      />
                    </label>
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Embedding Mode</label>
                      <select
                        value={useEmbeddingApi ? "api" : ""}
                        onChange={(event) => {
                          const nextMode = event.target.value === "api" ? "api" : "";
                          setSettings((current) => ({ ...current, embedding_mode: nextMode }));
                        }}
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                      >
                        <option value="">本地优先（默认）</option>
                        <option value="api">API</option>
                      </select>
                    </div>
                    {useEmbeddingApi ? (
                      <>
                        <div className="space-y-2">
                          <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Embedding API URL</label>
                          <input
                            type="text"
                            value={settings.embedding_api_base_url}
                            onChange={(event) =>
                              setSettings((current) => ({ ...current, embedding_api_base_url: event.target.value }))
                            }
                            placeholder="https://www.packyapi.com/v1"
                            className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Embedding Model</label>
                          <input
                            type="text"
                            value={settings.embedding_model_id}
                            onChange={(event) =>
                              setSettings((current) => ({ ...current, embedding_model_id: event.target.value }))
                            }
                            placeholder="text-embedding-3-small"
                            className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Embedding API Key</label>
                          <input
                            type="password"
                            value={settings.embedding_api_key}
                            onChange={(event) =>
                              setSettings((current) => ({ ...current, embedding_api_key: event.target.value }))
                            }
                            placeholder="sk-..."
                            className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Local Embedding Model</label>
                          <input
                            type="text"
                            value={settings.embedding_local_model_id}
                            onChange={(event) =>
                              setSettings((current) => ({ ...current, embedding_local_model_id: event.target.value }))
                            }
                            placeholder="google/embeddinggemma-300m"
                            className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <p className="rounded-2xl bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500">
                          当前为本地优先模式，仅使用本地 Embedding 模型配置。
                        </p>
                      </>
                    )}
                  </div>
                </GlowCard>

                <GlowCard className="rounded-[2.5rem] p-8">
                  <div className="mb-7 flex items-center gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-white">
                      <Key className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="font-black leading-none text-slate-900">MinerU API</h4>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">PDF Parsing Key</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Secret Key</label>
                      <input
                        type="password"
                        value={settings.mineru_api_token}
                        onChange={(event) => setSettings((current) => ({ ...current, mineru_api_token: event.target.value }))}
                        placeholder="MinerU Secret..."
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="px-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Storage</label>
                      <input
                        value={settings.storage_dir}
                        onChange={(event) => setSettings((current) => ({ ...current, storage_dir: event.target.value }))}
                        placeholder={`留空使用默认目录：${storagePath}`}
                        className="w-full rounded-2xl border border-slate-100 bg-white/50 px-5 py-4 text-sm outline-none transition focus:ring-2 focus:ring-emerald-500/20"
                      />
                      <button
                        onClick={() => void handlePickStorageDir()}
                        className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-xs font-black text-slate-700 ring-1 ring-slate-100"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        选择文件夹
                      </button>
                    </div>
                  </div>
                </GlowCard>
              </div>

              <div className="mb-6 flex gap-3">
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
                  className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-3 text-sm font-black text-slate-700 ring-1 ring-slate-100"
                >
                  <RefreshCcw className="h-4 w-4" />
                  重新健康检查
                </button>
              </div>

              <GlowCard className="rounded-[2.5rem] p-8">
                <div className="mb-6 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white">
                      <Terminal className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="font-black leading-none text-slate-900">DIAGNOSTICS</h4>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">System Health & Engine Logs</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-4 py-2">
                    <Activity className="h-3.5 w-3.5 animate-pulse text-emerald-500" />
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600">
                      {health.backend_status === "online" ? "Connection Active" : "Connection Issue"}
                    </span>
                  </div>
                </div>
                <div className="soft-scrollbar h-72 space-y-2 overflow-y-auto rounded-[1.6rem] bg-slate-900 p-6 font-mono text-[11px] text-slate-400">
                  {diagnostics.length === 0 ? (
                    <div className="text-slate-500">[INFO] 暂无日志。</div>
                  ) : (
                    diagnostics.map((entry) => (
                      <div key={entry} className="text-slate-300">
                        {entry}
                      </div>
                    ))
                  )}
                </div>
              </GlowCard>
            </div>
          </div>
        )}

        {isCreateKbOpen ? (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/10 p-6 backdrop-blur-xl">
            <GlowCard className="w-full max-w-lg rounded-[3rem] bg-white p-10 shadow-2xl">
              <div className="mb-8">
                <h2 className="text-2xl font-black italic tracking-tight text-slate-900">Create Workspace.</h2>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Start a new local workspace</p>
              </div>
              <div className="space-y-4">
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
                  className="w-full rounded-2xl border border-slate-100 bg-slate-50 px-6 py-4 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleCreateKnowledgeBase()}
                    disabled={!newKbName.trim() || isCreatingKb}
                    className="flex-1 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isCreatingKb ? "创建中..." : "创建 Workspace"}
                  </button>
                  <button
                    onClick={() => {
                      setIsCreateKbOpen(false);
                      setNewKbName("");
                    }}
                    className="rounded-2xl px-4 py-3 text-sm font-black text-slate-500 hover:bg-slate-100"
                  >
                    鍙栨秷
                  </button>
                </div>
              </div>
            </GlowCard>
          </div>
>>>>>>> 2acaeee (add embedding semantic search)
        ) : null}

        {view === "canvas" ? (
          <CanvasView
            activeKb={activeKb}
            activeKbId={activeKbId}
            canvasSessions={canvasSessions}
            activeSessionId={activeSessionId}
            isUploading={isUploading}
            activeDocuments={activeDocuments}
            activePreviewDocId={activePreviewDocId}
            activePreviewDocName={activePreviewDoc?.file_name ?? "未选择文档"}
            activePreviewMarkdown={activePreviewMarkdown}
            activePreviewSourcePath={activePreviewDoc?.source_path}
            previewLoading={previewLoading}
            previewError={previewError}
            activeAgent={activeAgent}
            isBootingAgent={isBootingAgent}
            onBackDashboard={() => setView("dashboard")}
            onCreateSession={handleCreateWorkspaceSession}
            onSelectSession={(sessionId) => {
              setActiveSessionId(sessionId);
              if (!activeKbId) return;
              switchAgentSession(activeKbId, sessionId);
            }}
            onDeleteSession={(sessionId) => void handleDeleteWorkspaceSession(sessionId)}
            onUpload={() => void handleUpload()}
            onOpenDocumentPreview={(docId) => void openDocumentPreview(docId)}
            onRetryDocument={(docId) => void handleRetryDocument(docId)}
            onDeleteDocument={(docId) => void handleDeleteDocument(docId)}
          />
        ) : null}

        {view === "settings" ? (
          <SettingsView
            settings={settings}
            health={health}
            diagnostics={diagnostics}
            storagePath={storagePath}
            isSavingSettings={isSavingSettings}
            onBack={() => setView(settingsReturnView)}
            onUpdateSettings={(update) => setSettings(update)}
            onPickStorageDir={() => void handlePickStorageDir()}
            onSaveSettings={() => void handleSaveSettings()}
            onRefreshHealth={() => void refreshHealth()}
          />
        ) : null}

        <CreateWorkspaceModal
          open={isCreateKbOpen}
          value={newKbName}
          loading={isCreatingKb}
          inputRef={createKbInputRef}
          onChange={setNewKbName}
          onCancel={() => {
            setIsCreateKbOpen(false);
            setNewKbName("");
          }}
          onCreate={() => void handleCreateKnowledgeBase()}
        />
      </div>
    </div>
  );
}
