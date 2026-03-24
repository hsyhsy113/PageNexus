import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  DefaultResourceLoader,
  SessionManager,
  runRpcMode,
} from "@mariozechner/pi-coding-agent";

const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const appHome = process.argv[3] ? path.resolve(process.argv[3]) : path.join(cwd, ".pagenexus-agent");
const buildSemanticOnly = process.argv.includes("--build-semantic-index");
const cliArgs = process.argv.slice(4);
const sessionDir = path.join(appHome, "sessions");
const agentDir = path.join(appHome, "agent-home");

const apiKey = process.env.PACKY_API_KEY;
const baseUrl = process.env.PACKY_API_BASE_URL ?? "https://www.packyapi.com/v1";
const modelId = process.env.PACKY_MODEL_ID ?? "gpt-5.4-low";
const apiMode = process.env.PACKY_API_MODE ?? "openai-completions";
const pythonBin = process.env.PAGENEXUS_PYTHON_BIN ?? "";
const embeddingApiKey =
  process.env.PAGENEXUS_EMBEDDING_API_KEY ?? process.env.PACKY_EMBEDDING_API_KEY ?? apiKey ?? "";
const embeddingBaseUrl =
  process.env.PAGENEXUS_EMBEDDING_API_BASE_URL ?? process.env.PACKY_EMBEDDING_API_BASE_URL ?? baseUrl;
const embeddingModel =
  process.env.PAGENEXUS_EMBEDDING_MODEL ?? process.env.PACKY_EMBEDDING_MODEL ?? "text-embedding-3-small";
const embeddingMode = (process.env.PAGENEXUS_EMBEDDING_MODE ?? "").trim().toLowerCase();
const embeddingLocalModel =
  process.env.PAGENEXUS_EMBEDDING_LOCAL_MODEL ?? "google/embeddinggemma-300m";
const localEmbedScriptPath = process.env.PAGENEXUS_LOCAL_EMBED_SCRIPT ?? "";
const embeddingEnabled = process.env.PAGENEXUS_ENABLE_SEMANTIC_SEARCH !== "0";
const forceRetrieval = process.env.PAGENEXUS_FORCE_RETRIEVAL !== "0";
const forceSemanticSearch = process.env.PAGENEXUS_FORCE_SEMANTIC_SEARCH !== "0";
const semanticLogEnabled = process.env.PAGENEXUS_SEMANTIC_LOG !== "0";
const queryRewriteEnabled = process.env.PAGENEXUS_QUERY_REWRITE !== "0";

const EMBEDDING_BATCH_SIZE = 10;
const SEMANTIC_INDEX_VERSION = 1;
const SEMANTIC_DEFAULT_TOP_K = 8;
const SEMANTIC_MAX_TOP_K = 20;
const SEMANTIC_MIN_CHARS = 80;
const SEMANTIC_MAX_CHARS = 800;
const LSH_PLANES = 24;
const SEMANTIC_LOG_SNIPPET_CHARS = 180;
const SEMANTIC_LEXICAL_WEIGHT = Math.max(
  0,
  Math.min(1, Number(process.env.PAGENEXUS_SEMANTIC_LEXICAL_WEIGHT ?? "0.2") || 0.2),
);
const SEMANTIC_MIN_SCORE = Number(process.env.PAGENEXUS_SEMANTIC_MIN_SCORE ?? "-1");

if (!apiKey && !buildSemanticOnly) {
  console.error("PACKY_API_KEY is required.");
  process.exit(1);
}

fs.mkdirSync(sessionDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

const semanticIndexPath = path.join(cwd, ".pagenexus-agent", "semantic-index.json");
fs.mkdirSync(path.dirname(semanticIndexPath), { recursive: true });
let localEmbedClient = null;
const queryRewriteCache = new Map();

function readArgValue(flag) {
  const idx = cliArgs.indexOf(flag);
  if (idx < 0) return null;
  if (idx + 1 >= cliArgs.length) return null;
  return String(cliArgs[idx + 1] ?? "").trim() || null;
}

const semanticTargetDocId = readArgValue("--doc-id");
const semanticRemoveDocId = readArgValue("--remove-doc-id");
if (semanticTargetDocId && semanticRemoveDocId) {
  throw new Error("cannot use --doc-id and --remove-doc-id together");
}

function resolveEmbeddingBackend() {
  const localConfigured = Boolean(embeddingLocalModel.trim()) && Boolean(localEmbedScriptPath.trim()) && Boolean(pythonBin.trim());
  const apiConfigured = Boolean(embeddingApiKey.trim()) && Boolean(embeddingBaseUrl.trim());

  if (embeddingMode === "local") {
    if (!localConfigured) throw new Error("embedding mode is local but local model/script/python is not configured");
    return "local";
  }
  if (embeddingMode === "api") {
    if (!apiConfigured) throw new Error("embedding mode is api but embedding api key/base is not configured");
    return "api";
  }
  if (localConfigured) return "local";
  if (apiConfigured) return "api";
  throw new Error("no embedding backend is configured. configure local model or embedding api");
}

const activeEmbeddingBackend = embeddingEnabled ? resolveEmbeddingBackend() : "disabled";

const kbPrompt = [
  "You are PageNexus, a desktop knowledge-base agent.",
  `Your workspace is the knowledge-base directory: ${cwd}`,
  "Parsed documents live under docs/<docId>/.",
  "Each parsed document typically contains the original source file, pages.json, fulltext.txt, parsed/full.md, parsed/content_list.json, parsed/layout.json, and parsed/images/.",
  "Use KB_INDEX.md first to understand what has already been parsed.",
  "KB_INDEX.md and the files currently present in the workspace are the source of truth for which documents exist now.",
  "If earlier conversation history conflicts with KB_INDEX.md or the current filesystem, explicitly correct the record and follow the current filesystem.",
  "Operate natively on the filesystem with the available tools.",
  embeddingEnabled
    ? "Semantic retrieval is available through tool `semantic_search`; always combine semantic hits with grep/file evidence before answering."
    : "Semantic retrieval is disabled.",
  forceRetrieval
    ? embeddingEnabled && forceSemanticSearch
      ? "Forced retrieval policy: for every user question, run `semantic_search` first, then run grep/find/read for exact evidence, then answer."
      : "Forced retrieval policy: for every user question, run grep/find/read for exact evidence, then answer."
    : "Retrieval policy: choose tools as needed, but prioritize grep/find/read evidence.",
  pythonBin
    ? `Python runtime is configured at: ${pythonBin}`
    : "Python runtime path is not explicitly configured; try python3/python if needed.",
  "When Python is configured, do not claim uncertainty; use that exact executable path directly.",
  "Before first Python task, verify by running: <python_bin> --version.",
  "Use this workflow unless the user explicitly asks otherwise:",
  embeddingEnabled && forceRetrieval && forceSemanticSearch
    ? "1. Run semantic_search for the user query first."
    : "1. Use ls/find first to understand the available files.",
  embeddingEnabled && forceRetrieval && forceSemanticSearch
    ? "2. Use grep or bash with rg to narrow down exact passages."
    : "2. Use grep or bash with rg to narrow down relevant pages or passages.",
  "3. Use read only on the smallest relevant files or ranges.",
  "4. Answer only from evidence you actually found.",
  forceRetrieval
    ? "Never skip retrieval before answering factual KB questions."
    : "If the question is factual and depends on KB contents, retrieve evidence first.",
  "Do not modify, rename, or delete files in this workspace.",
  "If the evidence is insufficient, say clearly that the answer was not found in the current knowledge base.",
<<<<<<< HEAD
  "When you answer with evidence, always cite file name and page number in the format 《文件名》p.N.",
  "Every final answer must include at least one citation in the format 《文件名》p.N when evidence exists.",
  "If multiple facts come from different pages, include multiple citations.",
  "For each important claim, include one short verbatim quote from the source text, then append citation in the same line: 「原文摘录」《文件名》p.N.",
  "Do not provide uncited claims. If no quote is available, explicitly state the evidence is insufficient.",
=======
  "When you answer with evidence, always cite file name and page number in the format 銆婃枃浠跺悕銆媝.N.",
>>>>>>> 2acaeee (add embedding semantic search)
  "Prefer citing the parsed document's original file name, not pages.json.",
].join("\n");

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const next = { ...schema };

  if (next.type === "object") {
    next.properties = Object.fromEntries(
      Object.entries(next.properties ?? {}).map(([key, value]) => [key, normalizeSchema(value)]),
    );
    next.required = Array.isArray(next.required) ? next.required : [];
    next.additionalProperties = next.additionalProperties ?? false;
  }

  if (next.type === "array" && next.items) {
    next.items = normalizeSchema(next.items);
  }

  if (Array.isArray(next.anyOf)) {
    next.anyOf = next.anyOf.map((item) => normalizeSchema(item));
  }

  if (Array.isArray(next.oneOf)) {
    next.oneOf = next.oneOf.map((item) => normalizeSchema(item));
  }

  return next;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function splitFixedWithOverlap(text, maxChars = SEMANTIC_MAX_CHARS) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length < SEMANTIC_MIN_CHARS) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks = [];
  const overlap = Math.min(120, Math.floor(maxChars / 6));
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + maxChars);
    chunks.push(cleaned.slice(start, end));
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((item) => item.length >= SEMANTIC_MIN_CHARS);
}

function splitSentences(paragraph) {
  const text = String(paragraph ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  // Prefer sentence boundaries first (English + Chinese punctuation).
  return text
    .split(/(?<=[銆傦紒锛燂紱.!?;])\s+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeChunksWithOverlap(chunks, maxChars = SEMANTIC_MAX_CHARS) {
  if (!chunks.length) return [];
  const overlap = Math.min(120, Math.floor(maxChars / 6));
  const merged = [chunks[0]];
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = chunks[i];
    const desiredPrefix = prev.slice(Math.max(0, prev.length - overlap)).trim();
    let combined = desiredPrefix ? `${desiredPrefix} ${current}` : current;
    if (combined.length > maxChars) {
      const keep = Math.max(0, maxChars - current.length - 1);
      const prefix = keep > 0 ? desiredPrefix.slice(Math.max(0, desiredPrefix.length - keep)) : "";
      combined = prefix ? `${prefix} ${current}` : current.slice(0, maxChars);
    }
    merged.push(combined.trim());
  }
  return merged;
}

function toChunks(text, maxChars = SEMANTIC_MAX_CHARS) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < SEMANTIC_MIN_CHARS) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const paragraphs = raw
    .split(/\n{2,}/g)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const sentenceUnits = (paragraphs.length ? paragraphs : [cleaned]).flatMap((paragraph) => splitSentences(paragraph));

  const rough = [];
  let current = "";
  for (const unit of sentenceUnits) {
    if (unit.length > maxChars) {
      if (current.length >= SEMANTIC_MIN_CHARS) {
        rough.push(current.trim());
      }
      current = "";
      rough.push(...splitFixedWithOverlap(unit, maxChars));
      continue;
    }
    const candidate = current ? `${current} ${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.length >= SEMANTIC_MIN_CHARS) {
      rough.push(current.trim());
      current = unit;
    } else {
      rough.push(...splitFixedWithOverlap(candidate, maxChars));
      current = "";
    }
  }
  if (current.length >= SEMANTIC_MIN_CHARS) {
    rough.push(current.trim());
  }

  const withOverlap = mergeChunksWithOverlap(rough, maxChars);
  const finalized = withOverlap.filter((item) => item.length >= SEMANTIC_MIN_CHARS);
  if (finalized.length > 0) return finalized;
  return splitFixedWithOverlap(cleaned, maxChars);
}

function toSingleLineSnippet(text, maxChars = SEMANTIC_LOG_SNIPPET_CHARS) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}...`;
}

const CROSS_LANG_QUERY_MAP = [
  ["\u6ce8\u610f\u529b\u673a\u5236", "attention mechanism"],
  ["\u81ea\u6ce8\u610f\u529b", "self attention"],
  ["\u591a\u5934\u6ce8\u610f\u529b", "multi-head attention"],
  ["\u4f4d\u7f6e\u7f16\u7801", "positional encoding"],
  ["\u524d\u9988\u7f51\u7edc", "feed-forward network"],
  ["\u53d8\u538b\u5668", "transformer"],
  ["\u7f16\u7801\u5668", "encoder"],
  ["\u89e3\u7801\u5668", "decoder"],
  ["\u6b8b\u5dee\u8fde\u63a5", "residual connection"],
  ["\u5c42\u5f52\u4e00\u5316", "layer normalization"],
  ["\u673a\u5668\u7ffb\u8bd1", "machine translation"],
];

function containsChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function normalizeForLexical(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function englishTokens(text) {
  return normalizeForLexical(text)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function chineseTerms(text) {
  const matches = String(text ?? "").match(/[\u3400-\u9fff]{2,}/g);
  return matches ? matches.filter(Boolean) : [];
}

function buildStaticQueryVariants(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return [];
  const variants = [raw];
  const normalized = normalizeForLexical(raw);
  for (const [cn, en] of CROSS_LANG_QUERY_MAP) {
    if (raw.includes(cn) && !normalized.includes(en)) {
      variants.push(`${raw} ${en}`);
    }
  }
  return Array.from(new Set(variants.map((item) => item.trim()).filter(Boolean)));
}

function normalizeRewriteText(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRewriteContent(payload) {
  const direct = payload?.choices?.[0]?.message?.content;
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    const joined = direct
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }
  if (typeof payload?.output_text === "string") {
    return payload.output_text;
  }
  return "";
}

async function rewriteQueryToEnglish(query) {
  const raw = String(query ?? "").trim();
  if (!raw || !containsChinese(raw) || !queryRewriteEnabled || !apiKey) {
    return "";
  }
  if (queryRewriteCache.has(raw)) {
    return queryRewriteCache.get(raw);
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: 32,
        messages: [
          {
            role: "system",
            content:
              "Translate Chinese query into concise English search phrase for technical retrieval. Output only English phrase.",
          },
          {
            role: "user",
            content: raw,
          },
        ],
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? `${response.status}`;
      throw new Error(`rewrite request failed: ${detail}`);
    }

    const content = extractRewriteContent(payload);
    const rewritten = normalizeRewriteText(content);
    if (!rewritten) {
      semanticDebugLog("[semantic_search] query rewrite empty response");
      return "";
    }
    semanticDebugLog(`[semantic_search] query rewrite en="${toSingleLineSnippet(rewritten, 160)}"`);
    queryRewriteCache.set(raw, rewritten);
    return rewritten;
  } catch (error) {
    semanticDebugLog(
      `[semantic_search] query rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

async function buildQueryVariants(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return [];
  const variants = buildStaticQueryVariants(raw);
  const rewritten = await rewriteQueryToEnglish(raw);
  if (rewritten) {
    variants.push(rewritten);
  }
  return Array.from(new Set(variants.map((item) => item.trim()).filter(Boolean)));
}

function lexicalScore(queryVariants, text) {
  const normalizedText = normalizeForLexical(text);
  if (!normalizedText) return 0;
  let best = 0;
  for (const variant of queryVariants) {
    const eng = englishTokens(variant);
    const zh = chineseTerms(variant);

    let engScore = 0;
    if (eng.length > 0) {
      const hit = eng.reduce((count, token) => count + (normalizedText.includes(token) ? 1 : 0), 0);
      engScore = hit / eng.length;
    }

    let zhScore = 0;
    if (zh.length > 0) {
      const hit = zh.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
      zhScore = hit / zh.length;
    }

    best = Math.max(best, engScore, zhScore);
  }
  return best;
}

function semanticDebugLog(line) {
  if (!semanticLogEnabled) return;
  process.stderr.write(`${line}\n`);
}

function gatherKnowledgeChunks(rootDir, docIdFilter = null) {
  const docsDir = path.join(rootDir, "docs");
  if (!fs.existsSync(docsDir)) {
    return [];
  }

  const chunks = [];
  const docIds = docIdFilter ? [docIdFilter] : fs.readdirSync(docsDir);
  for (const docId of docIds) {
    const pagesPath = path.join(docsDir, docId, "pages.json");
    if (!fs.existsSync(pagesPath)) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(pagesPath, "utf8"));
    } catch {
      continue;
    }
    const fileName = payload?.fileName ?? payload?.file_name ?? "unknown";
    const pages = Array.isArray(payload?.pages) ? payload.pages : [];
    for (const page of pages) {
      const pageNumber = Number(page?.pageNumber ?? page?.page_number ?? 0);
      const pageText = String(page?.text ?? "").trim();
      if (!pageText) continue;
      const pageChunks = toChunks(pageText);
      for (let index = 0; index < pageChunks.length; index += 1) {
        const text = pageChunks[index];
        const id = `${docId}:${pageNumber}:${index}`;
        chunks.push({
          id,
          docId,
          fileName,
          pageNumber,
          text,
        });
      }
    }
  }
  return chunks;
}

function collectDocIdsFromFilesystem(rootDir) {
  const docsDir = path.join(rootDir, "docs");
  if (!fs.existsSync(docsDir)) {
    return new Set();
  }
  const ids = new Set();
  for (const docId of fs.readdirSync(docsDir)) {
    const pagesPath = path.join(docsDir, docId, "pages.json");
    if (fs.existsSync(pagesPath)) {
      ids.add(docId);
    }
  }
  return ids;
}

function collectDocIdsFromIndex(index) {
  const ids = new Set();
  const rows = Array.isArray(index?.rows) ? index.rows : [];
  for (const row of rows) {
    const docId = String(row?.docId ?? "").trim();
    if (docId) ids.add(docId);
  }
  return ids;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function sortedSetItems(setValue) {
  return Array.from(setValue).sort();
}

function createLocalEmbedClient() {
  const child = spawn(
    pythonBin,
    [localEmbedScriptPath, "--model", embeddingLocalModel, "--server"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const pending = new Map();
  let nextId = 1;
  let closed = false;

  function rejectAllPending(reason) {
    for (const [, item] of pending) {
      item.reject(reason);
    }
    pending.clear();
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const raw = String(line ?? "").trim();
    if (!raw) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const id = Number(payload?.id);
    if (!Number.isFinite(id) || !pending.has(id)) return;
    const { resolve, reject, expected } = pending.get(id);
    pending.delete(id);
    if (payload?.error) {
      reject(new Error(`local embedding runner failed: ${payload.error}`));
      return;
    }
    const vectors = Array.isArray(payload?.embeddings) ? payload.embeddings : [];
    if (vectors.length !== expected) {
      reject(new Error(`local embedding returned ${vectors.length} vectors for ${expected} inputs`));
      return;
    }
    const fallbackCount = Number(payload?.fallback_count ?? 0);
    if (Number.isFinite(fallbackCount) && fallbackCount > 0) {
      semanticDebugLog(`[semantic_rebuild] local embed fallback_count=${fallbackCount}`);
    }
    resolve(vectors);
  });

  child.stderr.on("data", (chunk) => {
    const message = String(chunk ?? "").trim();
    if (!message) return;
    semanticDebugLog(`[semantic_rebuild] local_embedder: ${message}`);
  });

  child.on("error", (error) => {
    if (closed) return;
    closed = true;
    rejectAllPending(new Error(`local embedding runner failed to start: ${error.message}`));
  });

  child.on("close", (code, signal) => {
    if (closed) return;
    closed = true;
    const detail = signal ? `signal ${signal}` : `exit ${code}`;
    rejectAllPending(new Error(`local embedding runner closed unexpectedly: ${detail}`));
  });

  return {
    async embed(texts) {
      if (closed || child.stdin.destroyed) {
        throw new Error("local embedding runner is not available");
      }
      const id = nextId++;
      const message = JSON.stringify({ id, texts }) + "\n";
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, expected: texts.length });
        child.stdin.write(message, (error) => {
          if (error) {
            pending.delete(id);
            reject(new Error(`local embedding runner write failed: ${error.message}`));
          }
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      rejectAllPending(new Error("local embedding runner closed"));
      rl.close();
    },
  };
}

function getLocalEmbedClient() {
  if (!localEmbedClient) {
    localEmbedClient = createLocalEmbedClient();
  }
  return localEmbedClient;
}

async function embedBatch(texts) {
  if (activeEmbeddingBackend === "local") {
    const client = getLocalEmbedClient();
    return client.embed(texts);
  }

  const response = await fetch(`${embeddingBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? `${response.status}`;
    throw new Error(`embedding API request failed: ${detail}`);
  }

  const vectors = Array.isArray(payload?.data) ? payload.data : [];
  if (vectors.length !== texts.length) {
    throw new Error(`embedding API returned ${vectors.length} vectors for ${texts.length} inputs`);
  }

  return vectors
    .map((item) => item?.embedding)
    .filter((embedding) => Array.isArray(embedding))
    .map((embedding) => embedding.map((value) => Number(value)));
}

function dot(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}

function cosine(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

function createPlanes(dim, planesCount = LSH_PLANES) {
  const planes = [];
  let seed = 1337;
  function rnd() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }
  for (let i = 0; i < planesCount; i += 1) {
    const plane = new Array(dim);
    for (let j = 0; j < dim; j += 1) {
      plane[j] = rnd() * 2 - 1;
    }
    planes.push(plane);
  }
  return planes;
}

function signatureOf(vector, planes) {
  let sig = 0n;
  for (let i = 0; i < planes.length; i += 1) {
    const projection = dot(vector, planes[i]);
    if (projection >= 0) {
      sig |= 1n << BigInt(i);
    }
  }
  return sig;
}

function hamming(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

function tryLoadSemanticIndex() {
  if (!fs.existsSync(semanticIndexPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(semanticIndexPath, "utf8"));
    if (payload?.version !== SEMANTIC_INDEX_VERSION) return null;
    if (!Array.isArray(payload?.rows)) return null;
    return payload;
  } catch {
    return null;
  }
}

function persistSemanticIndex(payload) {
  fs.writeFileSync(semanticIndexPath, JSON.stringify(payload), "utf8");
}

function computeSourceFingerprint(rows) {
  return stableHash(
    JSON.stringify({
      backend: activeEmbeddingBackend,
      model: embeddingModel,
      localModel: embeddingLocalModel,
      base: embeddingBaseUrl,
      count: rows.length,
      ids: rows.map((item) => item.id),
      textHashes: rows.map((item) => item.textHash),
    }),
  );
}

async function ensureSemanticIndex(rootDir, options = {}) {
  if (!embeddingEnabled) {
    throw new Error("semantic search is disabled by PAGENEXUS_ENABLE_SEMANTIC_SEARCH");
  }
  if (activeEmbeddingBackend === "api" && !embeddingApiKey) {
    throw new Error(
      "embedding API key is missing. Set PAGENEXUS_EMBEDDING_API_KEY or PACKY_EMBEDDING_API_KEY.",
    );
  }

  const cached = tryLoadSemanticIndex();
  const cachedRows = Array.isArray(cached?.rows) ? cached.rows : [];
  const targetDocId = options.docId ?? null;
  const removeDocId = options.removeDocId ?? null;

  if (removeDocId) {
    const before = cachedRows.length;
    const nextRows = cachedRows.filter((row) => row.docId !== removeDocId);
    const removed = before - nextRows.length;
    semanticDebugLog(`[semantic_rebuild] remove doc=${removeDocId} removed_rows=${removed}`);
    const next = {
      version: SEMANTIC_INDEX_VERSION,
      createdAt: new Date().toISOString(),
      backend: activeEmbeddingBackend,
      model: embeddingModel,
      localModel: embeddingLocalModel,
      baseUrl: embeddingBaseUrl,
      sourceFingerprint: computeSourceFingerprint(nextRows),
      rows: nextRows,
    };
    persistSemanticIndex(next);
    semanticDebugLog(`[semantic_rebuild] done rows=${nextRows.length} path=${semanticIndexPath}`);
    return next;
  }

  const chunks = gatherKnowledgeChunks(rootDir, targetDocId).map((item) => ({
    ...item,
    textHash: stableHash(item.text),
  }));
  const rows = new Array(chunks.length);
  const canReuseCachedRows =
    Boolean(cached) &&
    cached.backend === activeEmbeddingBackend &&
    cached.model === embeddingModel &&
    cached.localModel === embeddingLocalModel &&
    cached.baseUrl === embeddingBaseUrl;
  const reusableRows = canReuseCachedRows ? cachedRows : [];
  const cachedById = new Map(
    reusableRows
      .filter((row) => (targetDocId ? row.docId === targetDocId : true))
      .map((row) => [row.id, row]),
  );

  const toEmbed = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const old = cachedById.get(chunk.id);
    const reusable =
      old &&
      old.textHash === chunk.textHash &&
      Array.isArray(old.embedding) &&
      old.embedding.length > 0;
    if (reusable) {
      rows[i] = {
        ...chunk,
        embedding: old.embedding,
      };
    } else {
      toEmbed.push({ slot: i, chunk });
    }
  }

  const reused = chunks.length - toEmbed.length;
  const totalBatches = Math.ceil(toEmbed.length / EMBEDDING_BATCH_SIZE);
  semanticDebugLog(
    `[semantic_rebuild] start mode=${targetDocId ? "doc" : "full"} doc=${targetDocId ?? "all"} chunks=${chunks.length} reused=${reused} to_embed=${toEmbed.length} batches=${totalBatches} backend=${activeEmbeddingBackend} model=${embeddingModel}`,
  );
  for (let i = 0; i < toEmbed.length; i += EMBEDDING_BATCH_SIZE) {
    const batchNo = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    const batch = toEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((item) => item.chunk.text));
    for (let j = 0; j < batch.length; j += 1) {
      rows[batch[j].slot] = {
        ...batch[j].chunk,
        embedding: vectors[j],
      };
    }
    const percent = totalBatches > 0 ? Math.round((batchNo / totalBatches) * 100) : 100;
    semanticDebugLog(
      `[semantic_rebuild] batch ${batchNo}/${Math.max(1, totalBatches)} (${percent}%) rows=${rows.filter(Boolean).length}`,
    );
  }

  const updatedDocRows = rows.filter(Boolean);
  const retainedRows = targetDocId
    ? reusableRows.filter((row) => row.docId !== targetDocId)
    : [];
  const finalizedRows = targetDocId ? [...retainedRows, ...updatedDocRows] : updatedDocRows;
  const next = {
    version: SEMANTIC_INDEX_VERSION,
    createdAt: new Date().toISOString(),
    backend: activeEmbeddingBackend,
    model: embeddingModel,
    localModel: embeddingLocalModel,
    baseUrl: embeddingBaseUrl,
    sourceFingerprint: computeSourceFingerprint(finalizedRows),
    rows: finalizedRows,
  };
  persistSemanticIndex(next);
  semanticDebugLog(`[semantic_rebuild] done rows=${finalizedRows.length} path=${semanticIndexPath}`);
  return next;
}

async function rebuildSemanticIndex(rootDir) {
  const index = await ensureSemanticIndex(rootDir, {
    docId: semanticTargetDocId,
    removeDocId: semanticRemoveDocId,
  });
  return {
    rows: index.rows.length,
    path: semanticIndexPath,
    model: embeddingModel,
  };
}

async function semanticSearch(rootDir, query, topK = SEMANTIC_DEFAULT_TOP_K) {
  let index = tryLoadSemanticIndex();
  const fsDocIds = collectDocIdsFromFilesystem(rootDir);
  const indexDocIds = collectDocIdsFromIndex(index);
  const docSetMatches = index ? sameSet(fsDocIds, indexDocIds) : false;

  if (!index || !docSetMatches) {
    const reason = !index ? "missing index" : "docId mismatch";
    semanticDebugLog(
      `[semantic_search] consistency docs_fs=${JSON.stringify(sortedSetItems(fsDocIds))} docs_index=${JSON.stringify(sortedSetItems(indexDocIds))}`,
    );
    semanticDebugLog(
      `[semantic_search] index consistency check failed (${reason}); rebuilding semantic index...`,
    );
    try {
      await ensureSemanticIndex(rootDir);
      index = tryLoadSemanticIndex();
      const rebuiltDocIds = collectDocIdsFromIndex(index);
      semanticDebugLog(
        `[semantic_search] consistency after rebuild docs_index=${JSON.stringify(sortedSetItems(rebuiltDocIds))}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`semantic index is stale and rebuild failed: ${detail}`);
    }
  }
  if (!index) {
    throw new Error("semantic index not found. Upload/parse docs to trigger index build first.");
  }
  if (!index.rows.length) return [];

  const queryVariants = await buildQueryVariants(query);
  if (!queryVariants.length) return [];
  semanticDebugLog(
    `[semantic_search] query_variants=${JSON.stringify(queryVariants.map((item) => toSingleLineSnippet(item, 160)))}`,
  );
  const queryEmbeddings = await embedBatch(queryVariants);
  const dim = queryEmbeddings[0]?.length ?? 0;
  if (!dim) return [];
  const planes = createPlanes(dim, LSH_PLANES);
  const querySigs = queryEmbeddings.map((vector) => signatureOf(vector, planes));

  const withSig = index.rows.map((row) => ({
    ...row,
    sig: signatureOf(row.embedding, planes),
  }));

  let candidates = withSig.filter((row) => querySigs.some((sig) => hamming(sig, row.sig) <= 8));
  if (candidates.length < Math.max(10, topK * 3)) {
    candidates = withSig;
  }

  return candidates
    .map((row) => ({
      ...row,
      semanticScore: Math.max(...queryEmbeddings.map((vector) => cosine(vector, row.embedding))),
      lexicalScore: lexicalScore(queryVariants, row.text),
    }))
    .map((row) => ({
      ...row,
      score: row.semanticScore * (1 - SEMANTIC_LEXICAL_WEIGHT) + row.lexicalScore * SEMANTIC_LEXICAL_WEIGHT,
    }))
    .filter((row) => row.score >= SEMANTIC_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(SEMANTIC_MAX_TOP_K, Math.max(1, topK)));
}

const model = {
  id: modelId,
  name: modelId,
  api: apiMode,
  provider: "packyapi",
  baseUrl,
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
  },
};

const authStorage = AuthStorage.inMemory({
  packyapi: {
    type: "api_key",
    key: apiKey,
  },
});

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  appendSystemPrompt: kbPrompt,
});

await resourceLoader.reload();

const tools = [
  createReadTool(cwd),
  createGrepTool(cwd),
  createFindTool(cwd),
  createLsTool(cwd),
  createBashTool(cwd),
].map((tool) => ({
  ...tool,
  parameters: normalizeSchema(tool.parameters),
}));

const semanticSearchTool = {
  name: "semantic_search",
  label: "semantic_search",
  description:
    "Semantic retrieval over parsed knowledge base using embeddings. Use it together with grep/find evidence.",
  parameters: normalizeSchema({
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query for semantic retrieval." },
      top_k: { type: "number", minimum: 1, maximum: SEMANTIC_MAX_TOP_K },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  async execute(_toolCallId, params) {
    const query = String(params?.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "semantic_search: empty query" }],
        details: { count: 0 },
      };
    }

    const topKRaw = Number(params?.top_k ?? SEMANTIC_DEFAULT_TOP_K);
    const topK = Number.isFinite(topKRaw) ? topKRaw : SEMANTIC_DEFAULT_TOP_K;
    semanticDebugLog(
      `[semantic_search] backend=${activeEmbeddingBackend} model=${embeddingModel} top_k=${topK} query="${toSingleLineSnippet(query, 120)}"`,
    );
    const hits = await semanticSearch(cwd, query, topK);
    if (!hits.length) {
      semanticDebugLog("[semantic_search] no hits");
    } else {
      const preview = hits
        .slice(0, 5)
        .map(
          (hit, index) =>
            `#${index + 1} ${hit.fileName} p.${hit.pageNumber} score=${hit.score.toFixed(4)} semantic=${hit.semanticScore.toFixed(4)} lexical=${hit.lexicalScore.toFixed(4)} text="${toSingleLineSnippet(hit.text)}"`,
        )
        .join("\n");
      semanticDebugLog(`[semantic_search] hits=${hits.length}\n${preview}`);
    }
    const text =
      hits.length === 0
        ? "semantic_search: no hits"
        : hits
            .map(
              (hit, index) =>
                `[${index + 1}] ${hit.fileName} p.${hit.pageNumber} score=${hit.score.toFixed(4)} semantic=${hit.semanticScore.toFixed(4)} lexical=${hit.lexicalScore.toFixed(4)}\n${hit.text}`,
            )
            .join("\n\n");

    return {
      content: [{ type: "text", text }],
      details: {
        count: hits.length,
        model: embeddingModel,
        baseUrl: embeddingBaseUrl,
      },
    };
  },
};

const effectiveTools = embeddingEnabled ? [...tools, semanticSearchTool] : tools;

const customTools = effectiveTools.map((tool) => ({
  name: tool.name,
  label: tool.label,
  description: tool.description,
  promptSnippet: `${tool.name}: ${tool.description}`,
  parameters: tool.parameters,
  execute(toolCallId, params, signal, onUpdate) {
    return tool.execute(toolCallId, params, signal, onUpdate);
  },
}));

if (buildSemanticOnly) {
  try {
    const result = await rebuildSemanticIndex(cwd);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`semantic index build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

process.on("exit", () => {
  if (localEmbedClient) {
    localEmbedClient.close();
  }
});

const { session } = await createAgentSession({
  cwd,
  agentDir,
  authStorage,
  model,
  thinkingLevel: "low",
  tools: [],
  customTools,
  resourceLoader,
  sessionManager: SessionManager.continueRecent(cwd, sessionDir),
});

await runRpcMode(session);

