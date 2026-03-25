import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { listDocuments, readPages, searchText } from "./api";

const listDocumentsSchema = Type.Object({
  kbId: Type.Optional(Type.String({ description: "知识库 ID，不传时使用当前知识库" }))
});

const searchTextSchema = Type.Object({
  kbId: Type.Optional(Type.String({ description: "知识库 ID，不传时使用当前知识库" })),
  query: Type.String({ description: "要检索的查询文本" }),
  documentIds: Type.Optional(Type.Array(Type.String(), { description: "限定检索的文档 ID 列表" })),
  limit: Type.Optional(Type.Number({ description: "最多返回多少个命中，默认 20" }))
});

const readPagesSchema = Type.Object({
  docId: Type.String({ description: "文档 ID" }),
  startPage: Type.Number({ description: "起始页码，从 1 开始" }),
  endPage: Type.Number({ description: "结束页码，从 1 开始" })
});

type ListDocumentsTool = AgentTool<typeof listDocumentsSchema, { count: number }>;
type SearchTextTool = AgentTool<typeof searchTextSchema, { count: number }>;
type ReadPagesTool = AgentTool<typeof readPagesSchema, { pageCount: number; continuation: number | null }>;
type KnowledgeBaseTool = ListDocumentsTool | SearchTextTool | ReadPagesTool;

export function createKnowledgeBaseTools(getKbId: () => string | null): KnowledgeBaseTool[] {
  const resolveKbId = (provided?: string) => {
    const kbId = provided || getKbId();
    if (!kbId) {
      throw new Error("当前没有选中的知识库。");
    }
    return kbId;
  };

  const listTool: ListDocumentsTool = {
    label: "List Documents",
    name: "kb_list_documents",
    description: "列出当前知识库中的文档和解析状态。先用它了解文档范围。",
    parameters: listDocumentsSchema,
    async execute(_toolCallId, params) {
      const documents = await listDocuments(resolveKbId(params.kbId));
      const text =
        documents.length === 0
          ? "当前知识库还没有文档。"
          : documents
              .map(
                (document, index) =>
                  `${index + 1}. ${document.file_name} | id=${document.id} | status=${document.status} | pages=${document.page_count}`,
              )
              .join("\n");

      return {
        content: [{ type: "text", text }],
        details: { count: documents.length }
      };
    }
  };

  const searchTool: SearchTextTool = {
    label: "Search Knowledge Base",
    name: "kb_search_text",
    description: "在当前知识库的页级文本中全文检索，返回文档名、页码和片段。必须先搜再读。",
    parameters: searchTextSchema,
    async execute(_toolCallId, params) {
      const matches = await searchText(resolveKbId(params.kbId), params.query, params.documentIds, params.limit);
      const text =
        matches.length === 0
          ? "未命中任何页面。"
          : matches
              .map(
                (match, index) =>
                  `[${index + 1}] 《${match.doc_name}》p.${match.page_number}\n${match.snippet}`,
              )
              .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { count: matches.length }
      };
    }
  };

  const readTool: ReadPagesTool = {
    label: "Read Pages",
    name: "kb_read_pages",
    description: "读取知识库文档的指定页段正文。只读必要页段，不要一次读取整份文档。",
    parameters: readPagesSchema,
    async execute(_toolCallId, params) {
      const result = await readPages(params.docId, params.startPage, params.endPage);
      const text = [
        `文档：${result.file_name}`,
        ...result.pages.map((page) => `--- 第 ${page.pageNumber} 页 ---\n${page.text}`)
      ].join("\n\n");

      return {
        content: [
          {
            type: "text",
            text:
              result.continuation === null
                ? text
                : `${text}\n\n[仍有后续内容，如需继续阅读请从第 ${result.continuation} 页开始。]`
          }
        ],
        details: {
          pageCount: result.page_count,
          continuation: result.continuation
        }
      };
    }
  };

  return [listTool, searchTool, readTool];
}
