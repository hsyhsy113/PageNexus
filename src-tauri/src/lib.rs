use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Cursor, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use lopdf::Document as LoPdfDocument;
use reqwest::{Client, StatusCode};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use tokio::time::sleep;
use uuid::Uuid;
use zip::ZipArchive;

const PACKY_API_BASE_URL: &str = "https://www.packyapi.com/v1";
const PACKY_MODEL_ID: &str = "gpt-5.4-low";
const MINERU_API_BASE_URL: &str = "https://mineru.net/api/v4";
const MINERU_MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
const MINERU_TARGET_FILE_BYTES: u64 = 170 * 1024 * 1024;
const MINERU_MAX_PAGES_PER_FILE: usize = 600;
const MINERU_TARGET_PAGES_PER_FILE: usize = 240;
const MINERU_UPLOAD_CONCURRENCY: usize = 4;

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
    db_path: PathBuf,
    agents: Arc<Mutex<HashMap<String, AgentProcess>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
struct AppSettings {
    packy_api_key: String,
    packy_api_base_url: String,
    packy_model_id: String,
    mineru_api_token: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            packy_api_key: String::new(),
            packy_api_base_url: PACKY_API_BASE_URL.to_string(),
            packy_model_id: PACKY_MODEL_ID.to_string(),
            mineru_api_token: String::new(),
        }
    }
}

struct AgentProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<serde_json::Value>>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct KnowledgeBase {
    id: String,
    name: String,
    theme: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DocumentRecord {
    id: String,
    kb_id: String,
    file_name: String,
    source_path: String,
    page_count: i64,
    status: String,
    error_message: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParsedPage {
    page_number: i64,
    text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SearchMatch {
    doc_id: String,
    doc_name: String,
    page_number: i64,
    snippet: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ReadPagesResult {
    doc_id: String,
    file_name: String,
    page_count: i64,
    start_page: i64,
    end_page: i64,
    continuation: Option<i64>,
    pages: Vec<ParsedPage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PagePreview {
    doc_id: String,
    file_name: String,
    page_count: i64,
    page_number: i64,
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ModelHealth {
    backend_status: String,
    model_status: String,
    detail: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatSessionPayload {
    title: String,
    messages: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedDocumentFile {
    doc_id: String,
    file_name: String,
    page_count: i64,
    pages: Vec<ParsedPage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchSubmitEnvelope {
    code: i64,
    msg: String,
    data: MineruBatchSubmitData,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchSubmitData {
    batch_id: String,
    file_urls: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchStatusEnvelope {
    code: i64,
    msg: String,
    data: MineruBatchStatusData,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchStatusData {
    batch_id: String,
    extract_result: Vec<MineruExtractResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruExtractResult {
    data_id: Option<String>,
    file_name: String,
    state: String,
    err_msg: String,
    full_zip_url: Option<String>,
    extract_progress: Option<MineruExtractProgress>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruExtractProgress {
    extracted_pages: i64,
    total_pages: i64,
    start_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchFileRequest {
    name: String,
    data_id: String,
    is_ocr: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchRequest {
    files: Vec<MineruBatchFileRequest>,
    model_version: String,
    enable_formula: bool,
    enable_table: bool,
    language: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruChunkManifest {
    chunk_id: String,
    file_name: String,
    page_start: usize,
    page_end: usize,
    page_count: usize,
    data_id: String,
    local_pdf_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MineruBatchManifest {
    batch_id: String,
    chunks: Vec<MineruChunkManifest>,
}

#[derive(Debug, Deserialize)]
struct ModelsEnvelope {
    data: Vec<ModelItem>,
}

#[derive(Debug, Deserialize)]
struct ModelItem {
    id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodingAgentBootstrap {
    state: serde_json::Value,
    messages: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodingAgentEventEnvelope {
    kb_id: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParserLogEvent {
    kb_id: String,
    doc_id: String,
    message: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn emit_parser_log(app: &AppHandle, kb_id: &str, doc_id: &str, message: impl Into<String>) {
    let message = message.into();
    println!("[parser][{kb_id}][{doc_id}] {message}");
    let _ = app.emit(
        "parser-log",
        ParserLogEvent {
            kb_id: kb_id.to_string(),
            doc_id: doc_id.to_string(),
            message,
        },
    );
}

fn db_connection(db_path: &Path) -> Result<Connection, String> {
    Connection::open(db_path).map_err(|error| error.to_string())
}

fn init_schema(db_path: &Path) -> Result<(), String> {
    let connection = db_connection(db_path)?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS knowledge_bases (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              theme TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS documents (
              id TEXT PRIMARY KEY,
              kb_id TEXT NOT NULL,
              file_name TEXT NOT NULL,
              source_path TEXT NOT NULL,
              page_count INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              error_message TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_sessions (
              id TEXT PRIMARY KEY,
              kb_id TEXT NOT NULL UNIQUE,
              title TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
            );
        "#,
        )
        .map_err(|error| error.to_string())
}

fn row_to_knowledge_base(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeBase> {
    Ok(KnowledgeBase {
        id: row.get(0)?,
        name: row.get(1)?,
        theme: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn row_to_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRecord> {
    Ok(DocumentRecord {
        id: row.get(0)?,
        kb_id: row.get(1)?,
        file_name: row.get(2)?,
        source_path: row.get(3)?,
        page_count: row.get(4)?,
        status: row.get(5)?,
        error_message: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn knowledge_base_dir(state: &AppState, kb_id: &str) -> PathBuf {
    state.data_dir.join("kbs").join(kb_id)
}

fn documents_dir(state: &AppState, kb_id: &str) -> PathBuf {
    knowledge_base_dir(state, kb_id).join("docs")
}

fn document_dir(state: &AppState, kb_id: &str, doc_id: &str) -> PathBuf {
    documents_dir(state, kb_id).join(doc_id)
}

fn session_file_path(state: &AppState, kb_id: &str) -> PathBuf {
    knowledge_base_dir(state, kb_id).join("session.json")
}

fn settings_file_path(state: &AppState) -> PathBuf {
    state.data_dir.join("settings.json")
}

fn load_app_settings(state: &AppState) -> Result<AppSettings, String> {
    let path = settings_file_path(state);
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str::<AppSettings>(&contents).map_err(|error| error.to_string())
}

fn save_app_settings_file(state: &AppState, settings: &AppSettings) -> Result<(), String> {
    let path = settings_file_path(state);
    let contents = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn node_binary_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("PAGENEXUS_NODE_BIN") {
        return PathBuf::from(explicit);
    }
    PathBuf::from("node")
}

fn coding_agent_script_path(app: &AppHandle) -> PathBuf {
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node/coding-agent-rpc.mjs");
    if local.exists() {
        return local;
    }

    app.path()
        .resolve("node/coding-agent-rpc.mjs", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
        .unwrap_or(local)
}

fn coding_agent_home_dir(state: &AppState, kb_id: &str) -> PathBuf {
    knowledge_base_dir(state, kb_id).join(".pagenexus-agent")
}

fn rpc_error_message(response: &serde_json::Value) -> String {
    response
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("coding agent request failed")
        .to_string()
}

fn send_rpc_request(
    process: &AgentProcess,
    mut command: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_id = Uuid::new_v4().to_string();
    command["id"] = json!(request_id);

    let (sender, receiver) = mpsc::channel();
    process
        .pending
        .lock()
        .map_err(|_| "coding agent pending-map lock poisoned".to_string())?
        .insert(request_id.clone(), sender);

    let line = format!(
        "{}\n",
        serde_json::to_string(&command).map_err(|error| error.to_string())?
    );

    let write_result = (|| -> Result<(), String> {
        let mut stdin = process
            .stdin
            .lock()
            .map_err(|_| "coding agent stdin lock poisoned".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    })();

    if let Err(error) = write_result {
        let _ = process
            .pending
            .lock()
            .map(|mut pending| pending.remove(&request_id));
        return Err(error);
    }

    receiver
        .recv_timeout(timeout)
        .map_err(|_| format!("coding agent request timed out: {}", command["type"]))
}

fn agent_is_running(process: &AgentProcess) -> bool {
    process
        .child
        .lock()
        .ok()
        .and_then(|mut child| child.try_wait().ok())
        .flatten()
        .is_none()
}

fn spawn_coding_agent(app: &AppHandle, state: &AppState, kb_id: &str) -> Result<AgentProcess, String> {
    let kb_dir = knowledge_base_dir(state, kb_id);
    fs::create_dir_all(&kb_dir).map_err(|error| error.to_string())?;

    let agent_home = coding_agent_home_dir(state, kb_id);
    fs::create_dir_all(&agent_home).map_err(|error| error.to_string())?;

    let script = coding_agent_script_path(app);
    let node = node_binary_path();
    let settings = load_app_settings(state)?;
    let api_key = settings.packy_api_key.trim();
    if api_key.is_empty() {
        return Err("未配置 PackyAPI API Key，请先到设置页保存。".to_string());
    }

    let mut child = Command::new(node)
        .arg(script)
        .arg(&kb_dir)
        .arg(&agent_home)
        .current_dir(&kb_dir)
        .env("PACKY_API_KEY", api_key)
        .env("PACKY_API_BASE_URL", &settings.packy_api_base_url)
        .env("PACKY_MODEL_ID", &settings.packy_model_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 pi coding agent：{error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "coding agent stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "coding agent stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "coding agent stderr unavailable".to_string())?;

    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(stdin));
    let pending = Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<serde_json::Value>>::new()));
    let stderr_buffer = Arc::new(Mutex::new(Vec::<String>::new()));

    {
        let pending = Arc::clone(&pending);
        let app = app.clone();
        let kb_id = kb_id.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }

                let payload = serde_json::from_str::<serde_json::Value>(&line)
                    .unwrap_or_else(|_| json!({ "type": "raw", "line": line }));

                if payload.get("type").and_then(|value| value.as_str()) == Some("response") {
                    if let Some(id) = payload.get("id").and_then(|value| value.as_str()) {
                        if let Ok(mut waiters) = pending.lock() {
                            if let Some(sender) = waiters.remove(id) {
                                let _ = sender.send(payload.clone());
                            }
                        }
                    }
                }

                let _ = app.emit(
                    "coding-agent-event",
                    CodingAgentEventEnvelope {
                        kb_id: kb_id.clone(),
                        payload,
                    },
                );
            }

            let _ = app.emit(
                "coding-agent-event",
                CodingAgentEventEnvelope {
                    kb_id,
                    payload: json!({ "type": "process_exit" }),
                },
            );
        });
    }

    {
        let app = app.clone();
        let kb_id = kb_id.to_string();
        let stderr_buffer = Arc::clone(&stderr_buffer);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(mut buffer) = stderr_buffer.lock() {
                    buffer.push(line.clone());
                    if buffer.len() > 200 {
                        buffer.remove(0);
                    }
                }
                let _ = app.emit(
                    "coding-agent-event",
                    CodingAgentEventEnvelope {
                        kb_id: kb_id.clone(),
                        payload: json!({ "type": "stderr", "line": line }),
                    },
                );
            }
        });
    }

    Ok(AgentProcess {
        child,
        stdin,
        pending,
    })
}

fn get_or_start_agent<'a>(
    app: &AppHandle,
    state: &'a AppState,
    kb_id: &str,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, AgentProcess>>, String> {
    let mut agents = state
        .agents
        .lock()
        .map_err(|_| "coding agent map lock poisoned".to_string())?;

    let should_spawn = agents
        .get(kb_id)
        .map(|process| !agent_is_running(process))
        .unwrap_or(true);

    if should_spawn {
        agents.remove(kb_id);
        let process = spawn_coding_agent(app, state, kb_id)?;
        agents.insert(kb_id.to_string(), process);
    }

    Ok(agents)
}

fn coding_agent_bootstrap(process: &AgentProcess) -> Result<CodingAgentBootstrap, String> {
    let state_response = send_rpc_request(process, json!({ "type": "get_state" }), Duration::from_secs(20))?;
    if !state_response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err(rpc_error_message(&state_response));
    }

    let messages_response =
        send_rpc_request(process, json!({ "type": "get_messages" }), Duration::from_secs(20))?;
    if !messages_response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err(rpc_error_message(&messages_response));
    }

    Ok(CodingAgentBootstrap {
        state: state_response.get("data").cloned().unwrap_or_else(|| json!({})),
        messages: messages_response
            .get("data")
            .and_then(|data| data.get("messages"))
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

fn stop_agent_process(process: AgentProcess) -> Result<(), String> {
    if let Ok(mut child) = process.child.lock() {
        child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_parsed_document(state: &AppState, doc_id: &str) -> Result<(DocumentRecord, ParsedDocumentFile), String> {
    let connection = db_connection(&state.db_path)?;
    let document = connection
        .query_row(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at FROM documents WHERE id = ?1",
            [doc_id],
            row_to_document,
        )
        .map_err(|error| error.to_string())?;

    let pages_path = document_dir(state, &document.kb_id, &document.id).join("pages.json");
    let content = fs::read_to_string(&pages_path).map_err(|error| error.to_string())?;
    let parsed: ParsedDocumentFile = serde_json::from_str(&content).map_err(|error| error.to_string())?;

    Ok((document, parsed))
}

fn trimmed_line(line: &str, query: &str, terms: &[String]) -> Option<String> {
    let normalized = line.trim();
    if normalized.is_empty() {
        return None;
    }

    let lower = normalized.to_lowercase();
    if lower.contains(query) || terms.iter().any(|term| lower.contains(term)) {
        let shortened = if normalized.chars().count() > 220 {
            let mut snippet = normalized.chars().take(220).collect::<String>();
            snippet.push('…');
            snippet
        } else {
            normalized.to_string()
        };
        return Some(shortened);
    }

    None
}

fn score_page(text: &str, query: &str, terms: &[String]) -> (i64, Option<String>) {
    let lower = text.to_lowercase();
    let exact_count = lower.matches(query).count() as i64;
    let term_hits = terms.iter().filter(|term| lower.contains(term.as_str())).count() as i64;
    let score = exact_count * 100 + term_hits * 10;

    if score == 0 {
        return (0, None);
    }

    let snippet = text
        .lines()
        .find_map(|line| trimmed_line(line, query, terms))
        .or_else(|| {
            let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if compact.is_empty() {
                None
            } else {
                let snippet = compact.chars().take(220).collect::<String>();
                Some(if compact.chars().count() > 220 {
                    format!("{snippet}…")
                } else {
                    snippet
                })
            }
        });

    (score, snippet)
}

fn supported_document_extension(file_path: &str) -> Option<&'static str> {
    let lower = file_path.to_lowercase();
    [
        ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".html",
    ]
    .into_iter()
    .find(|suffix| lower.ends_with(suffix))
}

fn ensure_supported_document(file_path: &str) -> Result<&'static str, String> {
    supported_document_extension(file_path)
        .ok_or_else(|| "当前仅支持 PDF / DOC / DOCX / PPT / PPTX / 图片 / HTML 文档。".to_string())
}

fn random_theme(count: i64) -> &'static str {
    match count % 4 {
        0 => "green",
        1 => "yellow",
        2 => "blue",
        _ => "rose",
    }
}

fn compute_initial_pdf_chunk_pages(page_count: usize, file_size_bytes: u64) -> usize {
    if page_count == 0 {
        return MINERU_TARGET_PAGES_PER_FILE;
    }

    let average_bytes = (file_size_bytes / page_count as u64).max(1);
    let estimated = (MINERU_TARGET_FILE_BYTES / average_bytes) as usize;
    estimated
        .clamp(40, MINERU_TARGET_PAGES_PER_FILE)
        .min(MINERU_MAX_PAGES_PER_FILE)
}

fn count_pdf_pages(source: &Path) -> Result<usize, String> {
    let document = LoPdfDocument::load(source).map_err(|error| error.to_string())?;
    Ok(document.get_pages().len())
}

fn save_pdf_page_range(
    document: &LoPdfDocument,
    all_pages: &[u32],
    start_page: usize,
    end_page: usize,
    target: &Path,
) -> Result<u64, String> {
    let keep = (start_page as u32..=end_page as u32).collect::<HashSet<_>>();
    let mut chunk = document.clone();
    let delete_pages = all_pages
        .iter()
        .copied()
        .filter(|page_number| !keep.contains(page_number))
        .collect::<Vec<_>>();

    if !delete_pages.is_empty() {
        chunk.delete_pages(&delete_pages);
    }
    chunk.prune_objects();
    chunk.renumber_objects();
    chunk.compress();
    chunk.save(target).map_err(|error| error.to_string())?;

    fs::metadata(target)
        .map(|metadata| metadata.len())
        .map_err(|error| error.to_string())
}

fn file_stem_for_chunks(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .replace(' ', "-")
}

fn push_pdf_chunk(
    document: &LoPdfDocument,
    all_pages: &[u32],
    output_dir: &Path,
    file_stem: &str,
    doc_id: &str,
    start_page: usize,
    end_page: usize,
    index: &mut usize,
    chunks: &mut Vec<MineruChunkManifest>,
) -> Result<(), String> {
    let page_count = end_page.saturating_sub(start_page) + 1;
    let chunk_id = format!("part-{:03}-p{}-{}", *index, start_page, end_page);
    let file_name = format!("{file_stem}-{chunk_id}.pdf");
    let path = output_dir.join(&file_name);
    let size = save_pdf_page_range(document, all_pages, start_page, end_page, &path)?;

    if size > MINERU_MAX_FILE_BYTES && page_count > 1 {
        let _ = fs::remove_file(&path);
        let midpoint = start_page + (page_count / 2) - 1;
        push_pdf_chunk(
            document,
            all_pages,
            output_dir,
            file_stem,
            doc_id,
            start_page,
            midpoint,
            index,
            chunks,
        )?;
        push_pdf_chunk(
            document,
            all_pages,
            output_dir,
            file_stem,
            doc_id,
            midpoint + 1,
            end_page,
            index,
            chunks,
        )?;
        return Ok(());
    }

    let manifest = MineruChunkManifest {
        chunk_id: chunk_id.clone(),
        file_name,
        page_start: start_page,
        page_end: end_page,
        page_count,
        data_id: format!("{doc_id}-{chunk_id}"),
        local_pdf_path: path.to_string_lossy().to_string(),
    };
    chunks.push(manifest);
    *index += 1;
    Ok(())
}

fn create_mineru_chunks(
    source: &Path,
    output_dir: &Path,
    original_file_name: &str,
    doc_id: &str,
) -> Result<Vec<MineruChunkManifest>, String> {
    let document = LoPdfDocument::load(source).map_err(|error| error.to_string())?;
    let all_pages = document.get_pages().into_keys().collect::<Vec<_>>();
    let page_count = all_pages.len();
    if page_count == 0 {
        return Err("PDF 没有可解析页。".to_string());
    }

    let file_size = fs::metadata(source).map_err(|error| error.to_string())?.len();
    let initial_chunk_pages = compute_initial_pdf_chunk_pages(page_count, file_size);
    let mut chunks = Vec::new();
    let mut index = 1usize;
    let file_stem = file_stem_for_chunks(original_file_name);
    let mut start = 1usize;

    while start <= page_count {
        let end = (start + initial_chunk_pages - 1).min(page_count).min(start + MINERU_MAX_PAGES_PER_FILE - 1);
        push_pdf_chunk(
            &document,
            &all_pages,
            output_dir,
            &file_stem,
            doc_id,
            start,
            end,
            &mut index,
            &mut chunks,
        )?;
        start = end + 1;
    }

    Ok(chunks)
}

fn create_single_file_manifest(source: &Path, original_file_name: &str, doc_id: &str) -> Result<Vec<MineruChunkManifest>, String> {
    let size = fs::metadata(source).map_err(|error| error.to_string())?.len();
    if size > MINERU_MAX_FILE_BYTES {
        return Err("非 PDF 文件暂不支持自动切块，请先压缩或拆分到 200MB 以内。".to_string());
    }

    Ok(vec![MineruChunkManifest {
        chunk_id: "part-001".to_string(),
        file_name: original_file_name.to_string(),
        page_start: 1,
        page_end: 1,
        page_count: 1,
        data_id: format!("{doc_id}-part-001"),
        local_pdf_path: source.to_string_lossy().to_string(),
    }])
}

#[allow(unreachable_code)]
async fn submit_mineru_batch(
    app: &AppHandle,
    kb_id: &str,
    doc_id: &str,
    token: &str,
    chunks: &[MineruChunkManifest],
) -> Result<MineruBatchStatusData, String> {
    let client = reqwest::Client::new();
    let request = MineruBatchRequest {
        files: chunks
            .iter()
            .map(|chunk| MineruBatchFileRequest {
                name: chunk.file_name.clone(),
                data_id: chunk.data_id.clone(),
                is_ocr: false,
            })
            .collect(),
        model_version: "pipeline".to_string(),
        enable_formula: true,
        enable_table: true,
        language: "en".to_string(),
    };

    emit_parser_log(
        app,
        kb_id,
        doc_id,
        format!("提交 MinerU 批量任务，共 {} 个切块。", chunks.len()),
    );

    let submit = client
        .post(format!("{MINERU_API_BASE_URL}/file-urls/batch"))
        .bearer_auth(token)
        .json(&request)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let submit_status = submit.status();
    let submit_body = submit.text().await.map_err(|error| error.to_string())?;
    if !submit_status.is_success() {
        return Err(format!("MinerU 批量提交失败：{} {}", submit_status, submit_body));
    }

    let envelope: MineruBatchSubmitEnvelope =
        serde_json::from_str(&submit_body).map_err(|error| error.to_string())?;
    if envelope.code != 0 {
        return Err(format!("MinerU 批量提交失败：{}", envelope.msg));
    }
    if envelope.data.file_urls.len() != chunks.len() {
        return Err("MinerU 返回的上传链接数量与切块数量不一致。".to_string());
    }

    #[derive(Clone)]
    struct UploadJob {
        file_name: String,
        local_pdf_path: String,
        upload_url: String,
    }

    let mut upload_jobs = Vec::<UploadJob>::new();

    for (chunk, upload_url) in chunks.iter().zip(envelope.data.file_urls.iter()) {
        emit_parser_log(
            app,
            kb_id,
            doc_id,
            format!(
                "上传切块 {} (p.{}-{})",
                chunk.file_name, chunk.page_start, chunk.page_end
            ),
        );
        upload_jobs.push(UploadJob {
            file_name: chunk.file_name.clone(),
            local_pdf_path: chunk.local_pdf_path.clone(),
            upload_url: upload_url.clone(),
        });
        continue;
        let bytes = fs::read(&chunk.local_pdf_path).map_err(|error| error.to_string())?;
        let response = client
            .put(upload_url)
            .body(bytes)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("MinerU 文件上传失败：{} -> {}", chunk.file_name, response.status()));
        }
    }

    for job_group in upload_jobs.chunks(MINERU_UPLOAD_CONCURRENCY) {
        let mut join_set = tokio::task::JoinSet::new();

        for job in job_group {
            let client = client.clone();
            let job = job.clone();

            join_set.spawn(async move {
                let bytes = fs::read(&job.local_pdf_path).map_err(|error| error.to_string())?;
                let response = client
                    .put(&job.upload_url)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("MinerU file upload failed: {} -> {}", job.file_name, response.status()));
                }
                Ok::<(), String>(())
            });
        }

        while let Some(result) = join_set.join_next().await {
            match result {
                Ok(inner) => inner?,
                Err(error) => return Err(format!("MinerU upload task join error: {error}")),
            }
        }
    }

    let mut attempts = 0usize;
    loop {
        attempts += 1;
        let response = client
            .get(format!(
                "{MINERU_API_BASE_URL}/extract-results/batch/{}",
                envelope.data.batch_id
            ))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("MinerU 批量轮询失败：{} {}", status, body));
        }

        let result: MineruBatchStatusEnvelope =
            serde_json::from_str(&body).map_err(|error| error.to_string())?;
        if result.code != 0 {
            return Err(format!("MinerU 批量轮询失败：{}", result.msg));
        }

        let all_done = result
            .data
            .extract_result
            .iter()
            .all(|item| item.state == "done");
        let first_failed = result
            .data
            .extract_result
            .iter()
            .find(|item| item.state == "failed");

        if let Some(failed) = first_failed {
            return Err(format!(
                "MinerU 解析失败：{} {}",
                failed.file_name, failed.err_msg
            ));
        }

        let progress_line = result
            .data
            .extract_result
            .iter()
            .map(|item| match &item.extract_progress {
                Some(progress) => format!(
                    "{} {} {}/{}",
                    item.file_name, item.state, progress.extracted_pages, progress.total_pages
                ),
                None => format!("{} {}", item.file_name, item.state),
            })
            .collect::<Vec<_>>()
            .join(" | ");
        emit_parser_log(app, kb_id, doc_id, format!("MinerU 轮询：{progress_line}"));

        if all_done {
            emit_parser_log(app, kb_id, doc_id, "MinerU 解析全部完成。");
            return Ok(result.data);
        }

        if attempts >= 240 {
            return Err("MinerU 解析超时，请稍后重试。".to_string());
        }

        sleep(Duration::from_secs(5)).await;
    }
}

fn find_single_file_with_suffix(dir: &Path, suffix: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|name| name.ends_with(suffix))
                .unwrap_or(false)
        {
            return Ok(path);
        }
    }
    Err(format!("未找到 {}", suffix))
}

fn recursive_add_page_offset(value: &mut serde_json::Value, offset: usize) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                if key == "page_idx" {
                    if let Some(number) = inner.as_i64() {
                        *inner = json!(number + offset as i64);
                    }
                } else {
                    recursive_add_page_offset(inner, offset);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                recursive_add_page_offset(item, offset);
            }
        }
        _ => {}
    }
}

fn copy_image_for_merge(
    chunk_root: &Path,
    merged_images_dir: &Path,
    chunk_label: &str,
    relative_path: &str,
) -> Result<String, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("empty-image-path".to_string());
    }
    let source = chunk_root.join(relative_path);
    let file_name = Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别图片文件名。".to_string())?;
    let merged_name = format!("{chunk_label}-{file_name}");
    let target = merged_images_dir.join(&merged_name);
    fs::create_dir_all(merged_images_dir).map_err(|error| error.to_string())?;
    fs::copy(source, target).map_err(|error| error.to_string())?;
    Ok(format!("images/{merged_name}"))
}

fn collect_item_text(item: &serde_json::Value) -> Vec<String> {
    let mut values = Vec::new();
    if item
        .get("type")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind == "discarded")
    {
        return values;
    }

    for key in ["text", "html", "latex"] {
        if let Some(text) = item.get(key).and_then(|value| value.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                values.push(trimmed.to_string());
            }
        }
    }

    for key in ["image_caption", "image_footnote", "table_caption", "table_footnote"] {
        if let Some(items) = item.get(key).and_then(|value| value.as_array()) {
            for value in items {
                if let Some(text) = value.as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        values.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    values
}

fn build_pages_from_content_list(content: &[serde_json::Value]) -> ParsedDocumentFile {
    let mut grouped = HashMap::<i64, Vec<String>>::new();
    let mut max_page_idx = 0i64;
    for item in content {
        let page_idx = item.get("page_idx").and_then(|value| value.as_i64()).unwrap_or(0);
        max_page_idx = max_page_idx.max(page_idx);
        let texts = collect_item_text(item);
        if texts.is_empty() {
            continue;
        }
        grouped.entry(page_idx).or_default().extend(texts);
    }

    let pages = (0..=max_page_idx)
        .map(|page_idx| ParsedPage {
            page_number: page_idx + 1,
            text: grouped
                .get(&page_idx)
                .map(|lines| lines.join("\n\n"))
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    ParsedDocumentFile {
        doc_id: String::new(),
        file_name: String::new(),
        page_count: pages.last().map(|page| page.page_number).unwrap_or(0),
        pages,
    }
}

async fn merge_mineru_results(
    app: &AppHandle,
    kb_id: &str,
    doc_dir: &Path,
    original_file_name: &str,
    doc_id: &str,
    chunks: &[MineruChunkManifest],
    results: &[MineruExtractResult],
) -> Result<ParsedDocumentFile, String> {
    let mineru_root = doc_dir.join("mineru");
    let downloads_dir = mineru_root.join("downloads");
    let chunks_dir = mineru_root.join("chunks");
    let parsed_dir = doc_dir.join("parsed");
    let merged_images_dir = parsed_dir.join("images");

    fs::create_dir_all(&downloads_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&chunks_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&merged_images_dir).map_err(|error| error.to_string())?;

    let client = Client::new();
    let mut merged_content = Vec::<serde_json::Value>::new();
    let mut merged_full_md = String::new();
    let mut merged_pdf_info = Vec::<serde_json::Value>::new();
    let mut backend = String::new();
    let mut version_name = String::new();

    emit_parser_log(app, kb_id, doc_id, "开始下载并合并 MinerU 结果。");

    for chunk in chunks {
        let result = results
            .iter()
            .find(|item| item.data_id.as_deref() == Some(chunk.data_id.as_str()))
            .ok_or_else(|| format!("缺少 MinerU 结果：{}", chunk.file_name))?;
        let zip_url = result
            .full_zip_url
            .clone()
            .ok_or_else(|| format!("MinerU 缺少结果包链接：{}", chunk.file_name))?;

        let zip_path = downloads_dir.join(format!("{}.zip", chunk.chunk_id));
        if !zip_path.exists() {
            emit_parser_log(app, kb_id, doc_id, format!("下载结果包：{}", chunk.chunk_id));
            let bytes = client
                .get(&zip_url)
                .send()
                .await
                .map_err(|error| error.to_string())?
                .bytes()
                .await
                .map_err(|error| error.to_string())?;
            fs::write(&zip_path, &bytes).map_err(|error| error.to_string())?;
        }

        let extract_dir = chunks_dir.join(&chunk.chunk_id);
        if !extract_dir.exists() {
            emit_parser_log(app, kb_id, doc_id, format!("解压结果包：{}", chunk.chunk_id));
            fs::create_dir_all(&extract_dir).map_err(|error| error.to_string())?;
            let data = fs::read(&zip_path).map_err(|error| error.to_string())?;
            let cursor = Cursor::new(data);
            let mut archive = ZipArchive::new(cursor).map_err(|error| error.to_string())?;
            for index in 0..archive.len() {
                let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
                let enclosed = file
                    .enclosed_name()
                    .map(|path| path.to_path_buf())
                    .ok_or_else(|| "MinerU zip 包含非法路径。".to_string())?;
                let out_path = extract_dir.join(enclosed);
                if file.name().ends_with('/') {
                    fs::create_dir_all(&out_path).map_err(|error| error.to_string())?;
                    continue;
                }
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let mut output = fs::File::create(&out_path).map_err(|error| error.to_string())?;
                let mut buffer = Vec::new();
                file.read_to_end(&mut buffer).map_err(|error| error.to_string())?;
                output.write_all(&buffer).map_err(|error| error.to_string())?;
            }
        }

        let content_list_path = find_single_file_with_suffix(&extract_dir, "_content_list.json")?;
        let full_md_path = extract_dir.join("full.md");
        let layout_path = extract_dir.join("layout.json");

        let mut content_list = serde_json::from_str::<Vec<serde_json::Value>>(
            &fs::read_to_string(&content_list_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        for item in &mut content_list {
            recursive_add_page_offset(item, chunk.page_start - 1);
            if let Some(img_path) = item.get("img_path").and_then(|value| value.as_str()) {
                if img_path.trim().is_empty() {
                    item["img_path"] = json!(null);
                } else {
                    let rewritten =
                        copy_image_for_merge(&extract_dir, &merged_images_dir, &chunk.chunk_id, img_path)?;
                    item["img_path"] = json!(rewritten);
                }
            }
        }
        merged_content.extend(content_list);

        let chunk_md = fs::read_to_string(&full_md_path).map_err(|error| error.to_string())?;
        if !merged_full_md.is_empty() {
            merged_full_md.push_str("\n\n");
        }
        merged_full_md.push_str(&format!(
            "<!-- {} pages {}-{} -->\n\n{}",
            chunk.chunk_id, chunk.page_start, chunk.page_end, chunk_md.trim()
        ));

        let mut layout = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(&layout_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if backend.is_empty() {
            backend = layout
                .get("_backend")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
        }
        if version_name.is_empty() {
            version_name = layout
                .get("_version_name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
        }
        if let Some(pdf_info) = layout.get_mut("pdf_info").and_then(|value| value.as_array_mut()) {
            for page in pdf_info {
                recursive_add_page_offset(page, chunk.page_start - 1);
                merged_pdf_info.push(page.clone());
            }
        }
    }

    let mut parsed = build_pages_from_content_list(&merged_content);
    parsed.doc_id = doc_id.to_string();
    parsed.file_name = original_file_name.to_string();

    fs::create_dir_all(&parsed_dir).map_err(|error| error.to_string())?;
    fs::write(parsed_dir.join("full.md"), &merged_full_md).map_err(|error| error.to_string())?;
    fs::write(
        parsed_dir.join("content_list.json"),
        serde_json::to_string_pretty(&merged_content).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        parsed_dir.join("layout.json"),
        serde_json::to_string_pretty(&json!({
            "pdf_info": merged_pdf_info,
            "_backend": backend,
            "_version_name": version_name,
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let pages_path = doc_dir.join("pages.json");
    fs::write(
        &pages_path,
        serde_json::to_string_pretty(&parsed).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let fulltext = parsed
        .pages
        .iter()
        .map(|page| page.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    fs::write(doc_dir.join("fulltext.txt"), fulltext).map_err(|error| error.to_string())?;
    emit_parser_log(app, kb_id, doc_id, "合并完成，已写入 pages.json / fulltext.txt / parsed/*。");

    Ok(parsed)
}

fn write_kb_catalog(state: &AppState, kb_id: &str) -> Result<(), String> {
    let connection = db_connection(&state.db_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at
             FROM documents WHERE kb_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([kb_id], row_to_document)
        .map_err(|error| error.to_string())?;
    let documents = rows
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut body = String::from("# PageNexus Knowledge Base Index\n\n");
    for document in documents {
        body.push_str(&format!("## {}\n\n", document.file_name));
        body.push_str(&format!("- status: {}\n", document.status));
        body.push_str(&format!("- pages: {}\n", document.page_count));
        body.push_str(&format!("- source: docs/{}/{}\n", document.id, Path::new(&document.source_path).file_name().and_then(|v| v.to_str()).unwrap_or("source")));
        body.push_str(&format!("- parsed markdown: docs/{}/parsed/full.md\n", document.id));
        body.push_str(&format!("- parsed structure: docs/{}/parsed/content_list.json\n", document.id));
        body.push_str(&format!("- grouped pages: docs/{}/pages.json\n\n", document.id));
    }

    fs::write(knowledge_base_dir(state, kb_id).join("KB_INDEX.md"), body).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_knowledge_base(name: String, state: State<'_, AppState>) -> Result<KnowledgeBase, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("知识库名称不能为空。".to_string());
    }

    let connection = db_connection(&state.db_path)?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM knowledge_bases", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    let kb = KnowledgeBase {
        id: Uuid::new_v4().to_string(),
        name: trimmed.to_string(),
        theme: random_theme(count).to_string(),
        created_at: now(),
        updated_at: now(),
    };

    connection
        .execute(
            "INSERT INTO knowledge_bases (id, name, theme, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kb.id, kb.name, kb.theme, kb.created_at, kb.updated_at],
        )
        .map_err(|error| error.to_string())?;

    fs::create_dir_all(documents_dir(&state, &kb.id)).map_err(|error| error.to_string())?;
    write_kb_catalog(&state, &kb.id)?;

    Ok(kb)
}

#[tauri::command]
fn list_knowledge_bases(state: State<'_, AppState>) -> Result<Vec<KnowledgeBase>, String> {
    let connection = db_connection(&state.db_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, theme, created_at, updated_at FROM knowledge_bases ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_knowledge_base)
        .map_err(|error| error.to_string())?;

    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn upload_pdf(
    kb_id: String,
    file_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DocumentRecord, String> {
    let extension = ensure_supported_document(&file_path)?;

    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("待上传的文档不存在。".to_string());
    }

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法识别文件名。".to_string())?
        .to_string();

    let doc_id = Uuid::new_v4().to_string();
    let created_at = now();
    let doc_dir = document_dir(&state, &kb_id, &doc_id);
    fs::create_dir_all(&doc_dir).map_err(|error| error.to_string())?;

    let stored_source = doc_dir.join(format!("source{extension}"));
    fs::copy(&source, &stored_source).map_err(|error| error.to_string())?;

    let initial = DocumentRecord {
        id: doc_id.clone(),
        kb_id: kb_id.clone(),
        file_name,
        source_path: stored_source.to_string_lossy().to_string(),
        page_count: 0,
        status: "queued".to_string(),
        error_message: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };

    let connection = db_connection(&state.db_path)?;
    connection
        .execute(
            "INSERT INTO documents (id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                initial.id,
                initial.kb_id,
                initial.file_name,
                initial.source_path,
                initial.page_count,
                initial.status,
                initial.error_message,
                initial.created_at,
                initial.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE documents SET status = 'parsing', updated_at = ?2 WHERE id = ?1",
            params![doc_id, now()],
        )
        .map_err(|error| error.to_string())?;
    emit_parser_log(&app, &kb_id, &doc_id, format!("开始处理文档：{}", initial.file_name));

    let settings = load_app_settings(&state)?;
    let mineru_token = settings.mineru_api_token.trim().to_string();
    if mineru_token.is_empty() {
        return Err("未配置 MinerU Token，请先到设置页保存。".to_string());
    }

    let parse_result: Result<ParsedDocumentFile, String> = async {
        let chunks_dir = doc_dir.join("mineru").join("input");
        fs::create_dir_all(&chunks_dir).map_err(|error| error.to_string())?;

        let chunks = if extension == ".pdf" {
            let file_size = fs::metadata(&stored_source)
                .map_err(|error| error.to_string())?
                .len();
            let page_count = count_pdf_pages(&stored_source)?;

            if file_size <= MINERU_MAX_FILE_BYTES && page_count <= MINERU_MAX_PAGES_PER_FILE {
                emit_parser_log(
                    &app,
                    &kb_id,
                    &doc_id,
                    format!(
                        "PDF size/page count is within threshold ({} bytes, {} pages), using single-file upload without chunking.",
                        file_size, page_count
                    ),
                );
                create_single_file_manifest(&stored_source, &initial.file_name, &doc_id)?
            } else {
                create_mineru_chunks(&stored_source, &chunks_dir, &initial.file_name, &doc_id)?
            }
        } else {
            create_single_file_manifest(&stored_source, &initial.file_name, &doc_id)?
        };
        emit_parser_log(
            &app,
            &kb_id,
            &doc_id,
            format!("切块完成，共 {} 个输入文件。", chunks.len()),
        );

        let batch_status = submit_mineru_batch(&app, &kb_id, &doc_id, &mineru_token, &chunks).await?;
        let batch_manifest = MineruBatchManifest {
            batch_id: batch_status.batch_id.clone(),
            chunks: chunks.clone(),
        };
        fs::write(
            doc_dir.join("mineru").join("batch_manifest.json"),
            serde_json::to_string_pretty(&batch_manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        merge_mineru_results(
            &app,
            &kb_id,
            &doc_dir,
            &initial.file_name,
            &doc_id,
            &chunks,
            &batch_status.extract_result,
        )
        .await
    }
    .await;

    if let Err(message) = parse_result {
        let connection = db_connection(&state.db_path)?;
        connection
            .execute(
                "UPDATE documents SET status = 'failed', error_message = ?2, updated_at = ?3 WHERE id = ?1",
                params![doc_id, message, now()],
            )
            .map_err(|error| error.to_string())?;

        return connection
            .query_row(
                "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at FROM documents WHERE id = ?1",
                [doc_id],
                row_to_document,
            )
            .map_err(|error| error.to_string());
    }

    let parsed = parse_result?;

    let connection = db_connection(&state.db_path)?;
    connection
        .execute(
            "UPDATE documents SET status = 'parsed', page_count = ?2, error_message = NULL, updated_at = ?3 WHERE id = ?1",
            params![doc_id, parsed.page_count, now()],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE knowledge_bases SET updated_at = ?2 WHERE id = ?1",
            params![kb_id, now()],
        )
        .map_err(|error| error.to_string())?;
    write_kb_catalog(&state, &kb_id)?;

    connection
        .query_row(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at FROM documents WHERE id = ?1",
            [doc_id],
            row_to_document,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_documents(kb_id: String, state: State<'_, AppState>) -> Result<Vec<DocumentRecord>, String> {
    let connection = db_connection(&state.db_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at
             FROM documents WHERE kb_id = ?1 ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([kb_id], row_to_document)
        .map_err(|error| error.to_string())?;

    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn search_text(
    kb_id: String,
    query: String,
    document_ids: Option<Vec<String>>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }

    let terms = normalized_query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    let effective_terms = if terms.is_empty() {
        vec![normalized_query.clone()]
    } else {
        terms
    };

    let connection = db_connection(&state.db_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at
             FROM documents WHERE kb_id = ?1 AND status = 'parsed'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([kb_id], row_to_document)
        .map_err(|error| error.to_string())?;
    let documents = rows
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let allowed = document_ids.unwrap_or_default();
    let filter_ids = !allowed.is_empty();
    let max_results = limit.unwrap_or(20);

    let mut scored = Vec::<(i64, SearchMatch)>::new();
    for document in documents {
        if filter_ids && !allowed.iter().any(|candidate| candidate == &document.id) {
            continue;
        }

        let (_, parsed) = read_parsed_document(&state, &document.id)?;
        for page in parsed.pages {
            let (score, snippet) = score_page(&page.text, &normalized_query, &effective_terms);
            if score == 0 {
                continue;
            }

            if let Some(snippet) = snippet {
                scored.push((
                    score,
                    SearchMatch {
                        doc_id: document.id.clone(),
                        doc_name: document.file_name.clone(),
                        page_number: page.page_number,
                        snippet,
                    },
                ));
            }
        }
    }

    scored.sort_by_key(|(score, item)| {
        (
            Reverse(*score),
            item.doc_name.clone(),
            item.page_number,
        )
    });

    Ok(scored
        .into_iter()
        .take(max_results)
        .map(|(_, item)| item)
        .collect())
}

#[tauri::command]
fn read_pages(
    doc_id: String,
    start_page: i64,
    end_page: i64,
    state: State<'_, AppState>,
) -> Result<ReadPagesResult, String> {
    let (document, parsed) = read_parsed_document(&state, &doc_id)?;
    let start = start_page.max(1);
    let end = end_page.max(start);

    let pages = parsed
        .pages
        .into_iter()
        .filter(|page| page.page_number >= start && page.page_number <= end)
        .collect::<Vec<_>>();

    if pages.is_empty() {
        return Err("指定页码范围没有可读内容。".to_string());
    }

    let continuation = if end < document.page_count {
        Some(end + 1)
    } else {
        None
    };

    Ok(ReadPagesResult {
        doc_id: document.id,
        file_name: document.file_name,
        page_count: document.page_count,
        start_page: start,
        end_page: end,
        continuation,
        pages,
    })
}

#[tauri::command]
fn get_document_page(doc_id: String, page_number: i64, state: State<'_, AppState>) -> Result<PagePreview, String> {
    let (document, parsed) = read_parsed_document(&state, &doc_id)?;
    let page = parsed
        .pages
        .into_iter()
        .find(|page| page.page_number == page_number)
        .ok_or_else(|| "指定页码不存在。".to_string())?;

    Ok(PagePreview {
        doc_id: document.id,
        file_name: document.file_name,
        page_count: document.page_count,
        page_number,
        text: page.text,
    })
}

#[tauri::command]
fn delete_document(doc_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let connection = db_connection(&state.db_path)?;
    let document = connection
        .query_row(
            "SELECT id, kb_id, file_name, source_path, page_count, status, error_message, created_at, updated_at FROM documents WHERE id = ?1",
            [doc_id.clone()],
            row_to_document,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在。".to_string())?;

    let target_dir = document_dir(&state, &document.kb_id, &document.id);
    if target_dir.exists() {
        fs::remove_dir_all(target_dir).map_err(|error| error.to_string())?;
    }

    connection
        .execute("DELETE FROM documents WHERE id = ?1", [doc_id])
        .map_err(|error| error.to_string())?;
    write_kb_catalog(&state, &document.kb_id)?;
    Ok(())
}

#[tauri::command]
fn save_chat_session(
    kb_id: String,
    payload: ChatSessionPayload,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_path = session_file_path(&state, &kb_id);
    if let Some(parent) = session_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let encoded = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(&session_path, encoded).map_err(|error| error.to_string())?;

    let connection = db_connection(&state.db_path)?;
    let created_at = now();
    connection
        .execute(
            "INSERT INTO chat_sessions (id, kb_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(kb_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            params![Uuid::new_v4().to_string(), kb_id, payload.title, created_at, now()],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn load_chat_session(kb_id: String, state: State<'_, AppState>) -> Result<Option<ChatSessionPayload>, String> {
    let session_path = session_file_path(&state, &kb_id);
    if !session_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&session_path).map_err(|error| error.to_string())?;
    let payload = serde_json::from_str::<ChatSessionPayload>(&content).map_err(|error| error.to_string())?;
    Ok(Some(payload))
}

#[tauri::command]
fn start_coding_agent(
    kb_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CodingAgentBootstrap, String> {
    let agents = get_or_start_agent(&app, &state, &kb_id)?;
    let process = agents
        .get(&kb_id)
        .ok_or_else(|| "coding agent did not start".to_string())?;
    coding_agent_bootstrap(process)
}

#[tauri::command]
fn prompt_coding_agent(
    kb_id: String,
    message: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let agents = get_or_start_agent(&app, &state, &kb_id)?;
    let process = agents
        .get(&kb_id)
        .ok_or_else(|| "coding agent unavailable".to_string())?;

    let response = send_rpc_request(
        process,
        json!({
            "type": "prompt",
            "message": message,
        }),
        Duration::from_secs(20),
    )?;

    if response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(rpc_error_message(&response))
    }
}

#[tauri::command]
fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    load_app_settings(&state)
}

#[tauri::command]
fn save_app_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    save_app_settings_file(&state, &settings)
}

#[tauri::command]
fn abort_coding_agent(kb_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let agents = state
        .agents
        .lock()
        .map_err(|_| "coding agent map lock poisoned".to_string())?;
    let process = agents
        .get(&kb_id)
        .ok_or_else(|| "coding agent unavailable".to_string())?;

    let response = send_rpc_request(process, json!({ "type": "abort" }), Duration::from_secs(10))?;
    if response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(rpc_error_message(&response))
    }
}

#[tauri::command]
fn stop_coding_agent(kb_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let process = state
        .agents
        .lock()
        .map_err(|_| "coding agent map lock poisoned".to_string())?
        .remove(&kb_id)
        .ok_or_else(|| "coding agent unavailable".to_string())?;

    stop_agent_process(process)
}

#[tauri::command]
async fn check_model_health(state: State<'_, AppState>) -> Result<ModelHealth, String> {
    let settings = load_app_settings(&state)?;
    let api_key = settings.packy_api_key.trim().to_string();
    if api_key.is_empty() {
        return Ok(ModelHealth {
            backend_status: "online".to_string(),
            model_status: "unavailable".to_string(),
            detail: "未配置 PackyAPI API Key，请到设置页填写。".to_string(),
        });
    }

    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/models", settings.packy_api_base_url))
        .bearer_auth(api_key)
        .send()
        .await;

    match response {
        Ok(response) => {
            if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
                return Ok(ModelHealth {
                    backend_status: "online".to_string(),
                    model_status: "unavailable".to_string(),
                    detail: "PackyAPI 返回鉴权失败，请检查设置页里的 API Key。".to_string(),
                });
            }

            if !response.status().is_success() {
                return Ok(ModelHealth {
                    backend_status: "offline".to_string(),
                    model_status: "unavailable".to_string(),
                    detail: format!("PackyAPI 响应异常：{}", response.status()),
                });
            }

            let envelope = response.json::<ModelsEnvelope>().await.map_err(|error| error.to_string())?;
            let found = envelope.data.iter().any(|model| model.id == settings.packy_model_id);

            Ok(ModelHealth {
                backend_status: "online".to_string(),
                model_status: if found { "ready" } else { "unavailable" }.to_string(),
                detail: if found {
                    format!("模型 {} 可用。", settings.packy_model_id)
                } else {
                    format!("PackyAPI 已连通，但未发现模型 {}。", settings.packy_model_id)
                },
            })
        }
        Err(error) => Ok(ModelHealth {
            backend_status: "offline".to_string(),
            model_status: "unavailable".to_string(),
            detail: format!("无法连接 PackyAPI：{error}"),
        }),
    }
}

fn prepare_state(app: &AppHandle) -> Result<AppState, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(data_dir.join("kbs")).map_err(|error| error.to_string())?;
    let db_path = data_dir.join("pagenexus.sqlite3");
    init_schema(&db_path)?;

    Ok(AppState {
        data_dir,
        db_path,
        agents: Arc::new(Mutex::new(HashMap::new())),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = prepare_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_knowledge_base,
            list_knowledge_bases,
            upload_pdf,
            list_documents,
            search_text,
            read_pages,
            get_document_page,
            delete_document,
            save_chat_session,
            load_chat_session,
            start_coding_agent,
            prompt_coding_agent,
            get_app_settings,
            save_app_settings,
            abort_coding_agent,
            stop_coding_agent,
            check_model_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use uuid::Uuid;

    use super::{
        build_pages_from_content_list, collect_item_text, compute_initial_pdf_chunk_pages, copy_image_for_merge,
        recursive_add_page_offset, score_page, ParsedPage, MINERU_TARGET_PAGES_PER_FILE,
    };

    #[test]
    fn score_page_prefers_exact_hits() {
        let text = "量子计算可以利用叠加态。\n第二段继续解释量子计算。";
        let (score, snippet) = score_page(text, "量子计算", &["量子计算".to_string()]);
        assert!(score >= 100);
        assert!(snippet.unwrap().contains("量子计算"));
    }

    #[test]
    fn parsed_page_serializes_with_camel_case() {
        let page = ParsedPage {
            page_number: 3,
            text: "hello".to_string(),
        };
        let value = serde_json::to_value(page).unwrap();
        assert_eq!(value["pageNumber"], 3);
        assert_eq!(value["text"], "hello");
    }

    #[test]
    fn compute_initial_chunk_pages_respects_limits() {
        let chunk_pages = compute_initial_pdf_chunk_pages(1184, 899 * 1024 * 1024);
        assert!(chunk_pages <= MINERU_TARGET_PAGES_PER_FILE);
        assert!(chunk_pages >= 40);
    }

    #[test]
    fn build_pages_from_content_groups_by_page_index() {
        let content = vec![
            json!({ "type": "text", "page_idx": 0, "text": "Alpha" }),
            json!({ "type": "discarded", "page_idx": 0, "text": "Header" }),
            json!({ "type": "image", "page_idx": 1, "image_caption": ["Figure caption"] }),
            json!({ "type": "text", "page_idx": 1, "text": "Beta" }),
        ];
        let parsed = build_pages_from_content_list(&content);
        assert_eq!(parsed.page_count, 2);
        assert_eq!(parsed.pages[0].page_number, 1);
        assert_eq!(parsed.pages[0].text, "Alpha");
        assert!(parsed.pages[1].text.contains("Figure caption"));
        assert!(parsed.pages[1].text.contains("Beta"));
    }

    #[test]
    fn recursive_add_page_offset_updates_nested_page_idx() {
        let mut value = json!({
            "page_idx": 0,
            "children": [{ "page_idx": 1 }]
        });
        recursive_add_page_offset(&mut value, 5);
        assert_eq!(value["page_idx"], 5);
        assert_eq!(value["children"][0]["page_idx"], 6);
    }

    #[test]
    fn collect_item_text_keeps_non_discarded_fields() {
        let values = collect_item_text(&json!({
            "type": "image",
            "image_caption": ["Caption"],
            "image_footnote": ["Footnote"],
            "text": "Ignored? no, keep"
        }));
        assert!(values.iter().any(|value| value == "Caption"));
        assert!(values.iter().any(|value| value == "Footnote"));
        assert!(values.iter().any(|value| value == "Ignored? no, keep"));
    }

    #[test]
    fn copy_image_for_merge_rewrites_into_shared_dir() {
        let root = std::env::temp_dir().join(format!("pagenexus-test-{}", Uuid::new_v4()));
        let chunk_dir = root.join("chunk");
        let images_dir = root.join("merged-images");
        fs::create_dir_all(chunk_dir.join("images")).unwrap();
        fs::write(chunk_dir.join("images/source.jpg"), b"image").unwrap();

        let rewritten = copy_image_for_merge(&chunk_dir, &images_dir, "part-001", "images/source.jpg").unwrap();
        assert_eq!(rewritten, "images/part-001-source.jpg");
        assert!(images_dir.join("part-001-source.jpg").exists());

        let _ = fs::remove_dir_all(root);
    }
}
