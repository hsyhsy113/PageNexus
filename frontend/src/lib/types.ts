import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type DocumentStatus = "queued" | "parsing" | "parsed" | "failed";

export interface KnowledgeBase {
  id: string;
  name: string;
  theme: "green" | "yellow" | "blue" | "rose";
  created_at: string;
  updated_at: string;
}

export interface DocumentRecord {
  id: string;
  kb_id: string;
  file_name: string;
  source_path: string;
  page_count: number;
  status: DocumentStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedPage {
  pageNumber: number;
  text: string;
}

export interface SearchMatch {
  doc_id: string;
  doc_name: string;
  page_number: number;
  snippet: string;
}

export interface ReadPagesResult {
  doc_id: string;
  file_name: string;
  page_count: number;
  start_page: number;
  end_page: number;
  continuation: number | null;
  pages: ParsedPage[];
}

export interface PagePreview {
  doc_id: string;
  file_name: string;
  page_count: number;
  page_number: number;
  text: string;
}

export interface SourceCitation {
  docName: string;
  pageNumber: number;
}

export interface ChatMessageViewModel {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: SourceCitation[];
  pending?: boolean;
}

export interface ChatSessionPayload {
  title: string;
  messages: AgentMessage[];
}

export interface ModelHealth {
  backend_status: "online" | "offline";
  model_status: "ready" | "unavailable";
  detail: string;
}

export interface AppSettings {
  packy_api_key: string;
  packy_api_base_url: string;
  packy_model_id: string;
  mineru_api_token: string;
}

export interface CodingAgentRuntimeState {
  model?: {
    id: string;
    provider: string;
    name?: string;
  };
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface CodingAgentBootstrap {
  state: CodingAgentRuntimeState;
  messages: AgentMessage[];
}
