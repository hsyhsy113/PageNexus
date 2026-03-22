import fs from "node:fs";
import path from "node:path";
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
const sessionDir = path.join(appHome, "sessions");
const agentDir = path.join(appHome, "agent-home");

const apiKey = process.env.PACKY_API_KEY;
const baseUrl = process.env.PACKY_API_BASE_URL ?? "https://www.packyapi.com/v1";
const modelId = process.env.PACKY_MODEL_ID ?? "gpt-5.4-low";

if (!apiKey) {
  console.error("PACKY_API_KEY is required.");
  process.exit(1);
}

fs.mkdirSync(sessionDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

const kbPrompt = [
  "You are PageNexus, a desktop knowledge-base agent.",
  `Your workspace is the knowledge-base directory: ${cwd}`,
  "Parsed documents live under docs/<docId>/.",
  "Each parsed document typically contains the original source file, pages.json, fulltext.txt, parsed/full.md, parsed/content_list.json, parsed/layout.json, and parsed/images/.",
  "Use KB_INDEX.md first to understand what has already been parsed.",
  "KB_INDEX.md and the files currently present in the workspace are the source of truth for which documents exist now.",
  "If earlier conversation history conflicts with KB_INDEX.md or the current filesystem, explicitly correct the record and follow the current filesystem.",
  "Operate natively on the filesystem with the available tools.",
  "Use this workflow unless the user explicitly asks otherwise:",
  "1. Use ls/find first to understand the available files.",
  "2. Use grep or bash with rg to narrow down relevant pages or passages.",
  "3. Use read only on the smallest relevant files or ranges.",
  "4. Answer only from evidence you actually found.",
  "Do not modify, rename, or delete files in this workspace.",
  "If the evidence is insufficient, say clearly that the answer was not found in the current knowledge base.",
  "When you answer with evidence, always cite file name and page number in the format 《文件名》p.N.",
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

const model = {
  id: modelId,
  name: modelId,
  api: "openai-responses",
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

const customTools = tools.map((tool) => ({
  name: tool.name,
  label: tool.label,
  description: tool.description,
  promptSnippet: `${tool.name}: ${tool.description}`,
  parameters: tool.parameters,
  execute(toolCallId, params, signal, onUpdate) {
    return tool.execute(toolCallId, params, signal, onUpdate);
  },
}));

const { session } = await createAgentSession({
  cwd,
  agentDir,
  authStorage,
  model,
  thinkingLevel: "low",
  tools: [],
  customTools,
  resourceLoader,
  sessionManager: SessionManager.create(cwd, sessionDir),
});

await runRpcMode(session);
