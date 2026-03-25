import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { InputRef } from "antd";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  checkModelHealth,
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
  detail: "Model health check has not been run yet.",
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
      logDiagnostic(`Health check failed: ${String(error)}`);
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
        logDiagnostic(`Failed to switch session: ${String(error)}`);
      });
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
      title: `${kbName} / Session 1`,
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
        logDiagnostic("pi coding agent exited.");
      }
      if (payload?.type === "response" && payload?.success === false && payload?.error) {
        logDiagnostic(`Agent error: ${payload.error}`);
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
      logDiagnostic(`Parser: ${event.payload.message}`);
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
          if (event.type === "tool_execution_start") logDiagnostic(`Tool started: ${event.toolName}`);
          if (event.type === "tool_execution_end") {
            logDiagnostic(`${event.isError ? "Tool failed" : "Tool finished"}: ${event.toolName}`);
          }
        });

        if (cancelled) {
          await session.dispose().catch(() => undefined);
          return;
        }

        activeSessionRef.current = session;
        setActiveAgent(asAgent(session));
        logDiagnostic("pi coding agent connected.");
      } catch (error) {
        logDiagnostic(`Failed to start knowledge-base Agent: ${String(error)}`);
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
      logDiagnostic("Please enter a knowledge base name.");
      return;
    }
    setIsCreatingKb(true);
    try {
      const knowledgeBase = await createKnowledgeBase(name);
      setKnowledgeBases((previous) => [knowledgeBase, ...previous]);
      setIsCreateKbOpen(false);
      setNewKbName("");
      enterWorkspace(knowledgeBase);
      logDiagnostic(`Created knowledge base: ${knowledgeBase.name}`);
    } catch (error) {
      logDiagnostic(`Failed to create knowledge base: ${String(error)}`);
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
      title: `${activeKb.name} / Session ${count}`,
    };
    setWorkspaceSessions((previous) => [session, ...previous]);
    setActiveSessionId(session.id);
    switchAgentSession(activeKb.id, session.id, true);
  };

  const handleDeleteWorkspaceSession = async (sessionId: string) => {
    if (!activeKbId) return;
    const target = workspaceSessions.find((session) => session.id === sessionId && session.kbId === activeKbId);
    if (!target) return;

    const confirmed = await confirm(`Confirm deleting session "${target.title}"?`, {
      title: "Delete Session",
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
        switchAgentSession(activeKbId, next.id, true);
      } else {
        const fallback: WorkspaceSession = {
          id: `session-${activeKbId}-${Date.now()}`,
          kbId: activeKbId,
          title: `${activeKb?.name ?? "Workspace"} / Session 1`,
        };
        setWorkspaceSessions((previous) => [fallback, ...previous]);
        setActiveSessionId(fallback.id);
        switchAgentSession(activeKbId, fallback.id, true);
      }

      logDiagnostic(`Deleted session: ${target.title}`);
    } catch (error) {
      logDiagnostic(`Failed to delete session: ${String(error)}`);
    }
  };

  const handleUpload = async () => {
    if (!activeKbId) {
      logDiagnostic("Please create or select a knowledge base first.");
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
      logDiagnostic(`MinerU parse finished: ${document.file_name} (${document.status})`);
    } catch (error) {
      setDocumentsByKb((previous) => ({
        ...previous,
        [activeKbId]: (previous[activeKbId] ?? []).filter((document) => document.id !== optimisticDocument.id),
      }));
      logDiagnostic(`Upload failed: ${String(error)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    const confirmed = await confirm("Confirm deleting this document and its parsed outputs?", {
      title: "Delete Document",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await deleteDocument(documentId);
      if (activeKbId) await refreshDocuments(activeKbId);
      logDiagnostic(`Deleted document: ${documentId}`);
    } catch (error) {
      logDiagnostic(`Failed to delete document: ${String(error)}`);
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
      logDiagnostic(`Retry parse finished: ${nextDocument.file_name} (${nextDocument.status})`);
    } catch (error) {
      await refreshDocuments(activeKbId);
      logDiagnostic(`Retry parse failed: ${String(error)}`);
    }
  };

  const handleDeleteKnowledgeBase = async (kbId: string, kbName: string) => {
    const confirmed = await confirm(`Confirm deleting knowledge base "${kbName}" and all its documents/sessions?`, {
      title: "Delete Knowledge Base",
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
      logDiagnostic(`Deleted knowledge base: ${kbName}`);
    } catch (error) {
      logDiagnostic(`Failed to delete knowledge base: ${String(error)}`);
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
        logDiagnostic("Storage directory saved. Restart the app to apply.");
      }
      logDiagnostic("Settings saved.");
    } catch (error) {
      logDiagnostic(`Failed to save settings: ${String(error)}`);
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
            activePreviewDocName={activePreviewDoc?.file_name ?? "No document selected"}
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
