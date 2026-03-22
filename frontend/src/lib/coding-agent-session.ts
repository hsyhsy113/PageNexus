import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { abortCodingAgent, promptCodingAgent, startCodingAgent, stopCodingAgent } from "./api";
import type { CodingAgentBootstrap, CodingAgentRuntimeState } from "./types";

type ToolStub = AgentTool<any>;

const TOOL_STUBS: ToolStub[] = [
  createToolStub("ls", "List files"),
  createToolStub("find", "Find files"),
  createToolStub("grep", "Search text"),
  createToolStub("read", "Read file"),
  createToolStub("bash", "Run shell command"),
];

function createToolStub(name: string, description: string): ToolStub {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as any,
    async execute() {
      return {
        content: [],
        details: {},
      };
    },
  };
}

function normalizeState(bootstrap: CodingAgentBootstrap): AgentState {
  return {
    systemPrompt: "",
    model: (bootstrap.state.model ?? {
      id: "gpt-5.4-low",
      provider: "packyapi",
      name: "gpt-5.4-low",
      api: "openai-completions",
      baseUrl: "https://www.packyapi.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }) as Model<any>,
    thinkingLevel: bootstrap.state.thinkingLevel ?? "low",
    tools: TOOL_STUBS,
    messages: Array.isArray(bootstrap.messages) ? bootstrap.messages : [],
    isStreaming: Boolean(bootstrap.state.isStreaming),
    streamMessage: null,
    pendingToolCalls: new Set<string>(),
    error: undefined,
  };
}

function replaceOrAppendMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const timestamp = (message as { timestamp?: number }).timestamp;
  const index = messages.findIndex((candidate) => {
    const sameRole = (candidate as { role?: string }).role === (message as { role?: string }).role;
    const candidateTimestamp = (candidate as { timestamp?: number }).timestamp;
    return sameRole && timestamp !== undefined && candidateTimestamp === timestamp;
  });

  if (index === -1) {
    return [...messages, message];
  }

  const next = [...messages];
  next[index] = message;
  return next;
}

function mergeMessages(messages: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  return incoming.reduce((next, message) => replaceOrAppendMessage(next, message), messages);
}

function removePendingToolCall(set: Set<string>, toolCallId: string): Set<string> {
  const next = new Set(set);
  next.delete(toolCallId);
  return next;
}

function applyRuntimeState(state: AgentState, runtime: Partial<CodingAgentRuntimeState>): AgentState {
  return {
    ...state,
    model: (runtime.model as Model<any>) ?? state.model,
    thinkingLevel: runtime.thinkingLevel ?? state.thinkingLevel,
    isStreaming: runtime.isStreaming ?? state.isStreaming,
  };
}

export class CodingAgentSessionAdapter {
  public state: AgentState;
  public streamFn: unknown;
  public getApiKey?: (provider: string) => Promise<string | undefined>;

  private listeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
  private unlisten?: UnlistenFn;

  private constructor(private kbId: string, bootstrap: CodingAgentBootstrap) {
    this.state = normalizeState(bootstrap);
  }

  static async create(kbId: string): Promise<CodingAgentSessionAdapter> {
    const bootstrap = await startCodingAgent(kbId);
    const session = new CodingAgentSessionAdapter(kbId, bootstrap);
    await session.attachEventStream();
    return session;
  }

  private async attachEventStream() {
    this.unlisten = await listen<{ kbId?: string; payload?: any }>("coding-agent-event", async (event) => {
      const envelope = event.payload;
      if (!envelope || envelope.kbId !== this.kbId) {
        return;
      }
      await this.handlePayload(envelope.payload);
    });
  }

  private async emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private async handlePayload(payload: any) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const type = payload.type;

    if (type === "response") {
      if (payload.command === "get_state" && payload.success && payload.data) {
        this.state = applyRuntimeState(this.state, payload.data);
      }
      if (!payload.success && payload.error) {
        this.state = { ...this.state, error: payload.error, isStreaming: false };
      }
      return;
    }

    if (type === "stderr") {
      return;
    }

    if (type === "process_exit") {
      this.state = { ...this.state, isStreaming: false };
      return;
    }

    switch (type as AgentEvent["type"]) {
      case "agent_start":
        this.state = { ...this.state, isStreaming: true, error: undefined };
        break;
      case "agent_end":
        this.state = {
          ...this.state,
          isStreaming: false,
          streamMessage: null,
          messages: Array.isArray(payload.messages) ? mergeMessages(this.state.messages, payload.messages) : this.state.messages,
          pendingToolCalls: new Set<string>(),
        };
        break;
      case "message_start":
        if (payload.message?.role === "user") {
          this.state = {
            ...this.state,
            messages: replaceOrAppendMessage(this.state.messages, payload.message),
          };
        }
        break;
      case "message_update":
        this.state = {
          ...this.state,
          streamMessage: payload.message,
        };
        break;
      case "message_end":
        this.state = {
          ...this.state,
          streamMessage: null,
          messages: replaceOrAppendMessage(this.state.messages, payload.message),
        };
        break;
      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.state.pendingToolCalls);
        pendingToolCalls.add(payload.toolCallId);
        this.state = { ...this.state, pendingToolCalls };
        break;
      }
      case "tool_execution_end":
        this.state = {
          ...this.state,
          pendingToolCalls: removePendingToolCall(this.state.pendingToolCalls, payload.toolCallId),
        };
        break;
      default:
        break;
    }

    await this.emit(payload as AgentEvent);
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async prompt(input: string): Promise<void> {
    await promptCodingAgent(this.kbId, input);
  }

  async abort(): Promise<void> {
    await abortCodingAgent(this.kbId);
  }

  setModel(_model: Model<any>) {}

  setThinkingLevel(level: ThinkingLevel) {
    this.state = { ...this.state, thinkingLevel: level };
  }

  async dispose() {
    this.unlisten?.();
    this.unlisten = undefined;
    await stopCodingAgent(this.kbId).catch(() => undefined);
  }
}

export function asAgent(session: CodingAgentSessionAdapter): Agent {
  return session as unknown as Agent;
}
