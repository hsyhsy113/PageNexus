import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  CodingAgentBootstrap,
  ChatSessionPayload,
  DocumentRecord,
  KnowledgeBase,
  ModelHealth,
  PagePreview,
  ReadPagesResult,
  SearchMatch
} from "./types";

export async function createKnowledgeBase(name: string): Promise<KnowledgeBase> {
  return invoke("create_knowledge_base", { name });
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return invoke("list_knowledge_bases");
}

export async function deleteKnowledgeBase(kbId: string): Promise<void> {
  return invoke("delete_knowledge_base", { kbId });
}

export async function uploadPdf(kbId: string, filePath: string): Promise<DocumentRecord> {
  return invoke("upload_pdf", { kbId, filePath });
}

export async function retryDocumentParse(docId: string): Promise<DocumentRecord> {
  return invoke("retry_document_parse", { docId });
}

export async function cancelDocumentParse(docId: string): Promise<DocumentRecord> {
  return invoke("cancel_document_parse", { docId });
}

export async function listDocuments(kbId: string): Promise<DocumentRecord[]> {
  return invoke("list_documents", { kbId });
}

export async function searchText(
  kbId: string,
  query: string,
  documentIds?: string[],
  limit?: number,
): Promise<SearchMatch[]> {
  return invoke("search_text", { kbId, query, documentIds, limit });
}

export async function readPages(docId: string, startPage: number, endPage: number): Promise<ReadPagesResult> {
  return invoke("read_pages", { docId, startPage, endPage });
}

export async function getDocumentPage(docId: string, pageNumber: number): Promise<PagePreview> {
  return invoke("get_document_page", { docId, pageNumber });
}

export async function getDocumentMarkdown(docId: string): Promise<string> {
  return invoke("get_document_markdown", { docId });
}

export async function deleteDocument(docId: string): Promise<void> {
  return invoke("delete_document", { docId });
}

export async function saveChatSession(kbId: string, payload: ChatSessionPayload): Promise<void> {
  return invoke("save_chat_session", { kbId, payload });
}

export async function loadChatSession(kbId: string): Promise<ChatSessionPayload | null> {
  return invoke("load_chat_session", { kbId });
}

export async function startCodingAgent(kbId: string): Promise<CodingAgentBootstrap> {
  return invoke("start_coding_agent", { kbId });
}

export async function promptCodingAgent(kbId: string, message: string): Promise<void> {
  return invoke("prompt_coding_agent", { kbId, message });
}

export async function abortCodingAgent(kbId: string): Promise<void> {
  return invoke("abort_coding_agent", { kbId });
}

export async function stopCodingAgent(kbId: string): Promise<void> {
  return invoke("stop_coding_agent", { kbId });
}

export async function setCodingAgentSession(kbId: string, sessionId: string): Promise<void> {
  return invoke("set_coding_agent_session", { kbId, sessionId });
}

export async function deleteCodingAgentSession(kbId: string, sessionId: string): Promise<void> {
  return invoke("delete_coding_agent_session", { kbId, sessionId });
}

export async function checkModelHealth(): Promise<ModelHealth> {
  return invoke("check_model_health");
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke("get_app_settings");
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  return invoke("save_app_settings", { settings });
}

export async function getEffectiveStoragePath(): Promise<string> {
  return invoke("get_effective_storage_path");
}
