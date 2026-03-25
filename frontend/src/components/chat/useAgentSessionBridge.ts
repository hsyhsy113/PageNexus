import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { BubbleItemType } from "@ant-design/x";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { useEffect, useMemo, useState } from "react";
import type { AssistantBubbleContent, UserBubbleContent } from "./chat-types";

type BridgeState = {
  items: BubbleItemType[];
  isStreaming: boolean;
};

type TextBlock = { type: "text"; text: string };

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    "text" in block &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function userText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
  }

  if (message.role === "user-with-attachments") {
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      return message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
  }

  return "";
}

function mapMessageToBubble(
  message: AgentMessage,
  index: number,
  toolResultsById: Record<string, ToolResultMessage>,
  pendingToolCallIds: string[],
): BubbleItemType | null {
  if (message.role === "assistant") {
    const content: AssistantBubbleContent = {
      kind: "assistant",
      message,
      toolResultsById,
      pendingToolCallIds,
      isStreaming: false,
    };

    return {
      key: `assistant-${message.timestamp ?? index}-${index}`,
      role: "ai",
      content,
    };
  }

  if (message.role === "user" || message.role === "user-with-attachments") {
    const text = userText(message);
    if (!text) return null;

    const content: UserBubbleContent = {
      kind: "user",
      text,
    };

    return {
      key: `user-${message.timestamp ?? index}-${index}`,
      role: "user",
      content,
    };
  }

  return null;
}

function snapshotSession(session: Agent): BridgeState {
  const toolResultsById: Record<string, ToolResultMessage> = {};
  for (const message of session.state.messages) {
    if (message.role === "toolResult") {
      toolResultsById[message.toolCallId] = message;
    }
  }

  const pendingToolCallIds = [...session.state.pendingToolCalls.values()];

  const items = session.state.messages
    .map((message, index) => mapMessageToBubble(message, index, toolResultsById, pendingToolCallIds))
    .filter((item): item is BubbleItemType => Boolean(item));

  if (session.state.isStreaming && session.state.streamMessage?.role === "assistant") {
    const content: AssistantBubbleContent = {
      kind: "assistant",
      message: session.state.streamMessage as AssistantMessage,
      toolResultsById,
      pendingToolCallIds,
      isStreaming: true,
    };

    items.push({
      key: "assistant-streaming",
      role: "ai",
      content,
      status: "loading",
    });
  }

  return {
    items,
    isStreaming: session.state.isStreaming,
  };
}

export function useAgentSessionBridge(session: Agent | null) {
  const [state, setState] = useState<BridgeState>({
    items: [],
    isStreaming: false,
  });

  useEffect(() => {
    if (!session) {
      setState({ items: [], isStreaming: false });
      return;
    }

    setState(snapshotSession(session));
    const unsubscribe = session.subscribe(() => {
      setState(snapshotSession(session));
    });
    return unsubscribe;
  }, [session]);

  const actions = useMemo(
    () => ({
      async send(message: string) {
        if (!session || !message.trim()) return;
        await session.prompt(message.trim());
      },
      stop() {
        if (!session) return;
        session.abort();
      },
    }),
    [session],
  );

  return {
    items: state.items,
    isStreaming: state.isStreaming,
    send: actions.send,
    stop: actions.stop,
  };
}
