import { useEffect, useRef, useState } from "react";
import { streamChatMessage, type MessageStatus } from "../api/chatApi";
import { getConversationMessages } from "../api/conversationApi";
import ChatInput from "./ChatInput";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  status: MessageStatus;
};

type RichTitleBlock = {
  type: "title";
  text: string;
};

type RichHeadingBlock = {
  type: "heading";
  level: number;
  text: string;
};

type RichParagraphBlock = {
  type: "paragraph";
  text: string;
};

type RichListBlock = {
  type: "list";
  ordered: boolean;
  items: string[];
};

type RichCodeBlock = {
  type: "code";
  language: string;
  code: string;
};

type RichTableBlock = {
  type: "table";
  headers: string[];
  rows: string[][];
};

type RichQuoteBlock = {
  type: "quote";
  text: string;
};

type RichCalloutBlock = {
  type: "callout";
  variant: "info" | "tip" | "warning" | "caution";
  title: string;
  text: string;
};

type RichBlock =
  | RichTitleBlock
  | RichHeadingBlock
  | RichParagraphBlock
  | RichListBlock
  | RichCodeBlock
  | RichTableBlock
  | RichQuoteBlock
  | RichCalloutBlock;

type RichResponse = {
  blocks: RichBlock[];
};

type ChatWindowProps = {
  selectedConversationId: string | null;
  onConversationCreated: (conversationId: string) => void;
  onConversationUpdated: () => void | Promise<void>;
};

function createLocalId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

function normalizeStatus(status: string | null | undefined): MessageStatus {
  if (status === "pending" || status === "streaming" || status === "completed" || status === "failed") {
    return status;
  }
  if (status === "complete") {
    return "completed";
  }
  return "completed";
}

function parseRichResponse(content: string): RichResponse | null {
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");

  const isStringMatrix = (value: unknown): value is string[][] =>
    Array.isArray(value) && value.every((row) => isStringArray(row));

  try {
    const parsed = JSON.parse(content) as { blocks?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) {
      return null;
    }

    const normalizedBlocks: RichBlock[] = [];

    for (const block of parsed.blocks) {
      if (!block || typeof block !== "object" || !("type" in block)) {
        continue;
      }

      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === "title" && typeof typedBlock.text === "string") {
        normalizedBlocks.push({ type: "title", text: typedBlock.text });
        continue;
      }

      if (
        typedBlock.type === "heading" &&
        typeof typedBlock.text === "string" &&
        typeof typedBlock.level === "number" &&
        Number.isInteger(typedBlock.level) &&
        typedBlock.level >= 1 &&
        typedBlock.level <= 4
      ) {
        normalizedBlocks.push({
          type: "heading",
          level: typedBlock.level,
          text: typedBlock.text,
        });
        continue;
      }

      if (typedBlock.type === "paragraph" && typeof typedBlock.text === "string") {
        normalizedBlocks.push({ type: "paragraph", text: typedBlock.text });
        continue;
      }

      if (
        typedBlock.type === "list" &&
        typeof typedBlock.ordered === "boolean" &&
        isStringArray(typedBlock.items)
      ) {
        normalizedBlocks.push({
          type: "list",
          ordered: typedBlock.ordered,
          items: typedBlock.items,
        });
        continue;
      }

      if (
        typedBlock.type === "code" &&
        typeof typedBlock.language === "string" &&
        typeof typedBlock.code === "string"
      ) {
        normalizedBlocks.push({
          type: "code",
          language: typedBlock.language,
          code: typedBlock.code,
        });
        continue;
      }

      if (
        typedBlock.type === "table" &&
        isStringArray(typedBlock.headers) &&
        isStringMatrix(typedBlock.rows)
      ) {
        normalizedBlocks.push({
          type: "table",
          headers: typedBlock.headers,
          rows: typedBlock.rows,
        });
        continue;
      }

      if (typedBlock.type === "quote" && typeof typedBlock.text === "string") {
        normalizedBlocks.push({ type: "quote", text: typedBlock.text });
        continue;
      }

      if (
        typedBlock.type === "callout" &&
        (typedBlock.variant === "info" ||
          typedBlock.variant === "tip" ||
          typedBlock.variant === "warning" ||
          typedBlock.variant === "caution") &&
        typeof typedBlock.title === "string" &&
        typeof typedBlock.text === "string"
      ) {
        const variant = typedBlock.variant as RichCalloutBlock["variant"];
        normalizedBlocks.push({
          type: "callout",
          variant,
          title: typedBlock.title,
          text: typedBlock.text,
        });
      }
    }

    return { blocks: normalizedBlocks };
  } catch {
    return null;
  }
}

function renderHeadingText(level: number, text: string) {
  if (level <= 1) {
    return <h1 className="text-2xl font-bold">{text}</h1>;
  }
  if (level === 2) {
    return <h2 className="text-xl font-semibold">{text}</h2>;
  }
  if (level === 3) {
    return <h3 className="text-lg font-semibold">{text}</h3>;
  }
  return <h4 className="text-base font-semibold">{text}</h4>;
}

function renderAssistantContent(message: ChatMessage) {
  const parsed = parseRichResponse(message.content);
  if (!parsed || parsed.blocks.length === 0 || message.status !== "completed") {
    return <p className="whitespace-pre-wrap">{message.content || (message.status === "pending" ? "Thinking..." : "")}</p>;
  }

  return (
    <div className="space-y-3">
      {parsed.blocks.map((block, index) => {
        if (block.type === "title") {
          return (
            <h1 key={`block-${index}`} className="text-2xl font-bold">
              {block.text}
            </h1>
          );
        }

        if (block.type === "heading") {
          return <div key={`block-${index}`}>{renderHeadingText(block.level, block.text)}</div>;
        }

        if (block.type === "paragraph") {
          return (
            <p key={`block-${index}`} className="whitespace-pre-wrap leading-relaxed">
              {block.text}
            </p>
          );
        }

        if (block.type === "list") {
          if (block.ordered) {
            return (
              <ol key={`block-${index}`} className="pl-6 space-y-1 list-decimal">
                {block.items.map((item, itemIndex) => (
                  <li key={`list-item-${index}-${itemIndex}`}>{item}</li>
                ))}
              </ol>
            );
          }
          return (
            <ul key={`block-${index}`} className="pl-6 space-y-1 list-disc">
              {block.items.map((item, itemIndex) => (
                <li key={`list-item-${index}-${itemIndex}`}>{item}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "code") {
          return (
            <div key={`block-${index}`} className="rounded border border-neutral-600 bg-neutral-900 overflow-hidden">
              <div className="px-3 py-1 text-xs text-neutral-300 border-b border-neutral-700">
                {block.language || "text"}
              </div>
              <pre className="p-3 text-sm overflow-x-auto">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === "table") {
          return (
            <div key={`block-${index}`} className="overflow-x-auto">
              <table className="min-w-full text-sm border border-neutral-600">
                <thead className="bg-neutral-700">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`th-${index}-${headerIndex}`} className="px-3 py-2 text-left border-b border-neutral-600">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`tr-${index}-${rowIndex}`} className="border-b border-neutral-700">
                      {row.map((cell, cellIndex) => (
                        <td key={`td-${index}-${rowIndex}-${cellIndex}`} className="px-3 py-2">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={`block-${index}`} className="border-l-4 border-neutral-500 pl-3 italic text-neutral-100">
              {block.text}
            </blockquote>
          );
        }

        if (block.type === "callout") {
          const variantClass =
            block.variant === "warning"
              ? "border-yellow-500 bg-yellow-900/30"
              : block.variant === "caution"
                ? "border-red-500 bg-red-900/30"
                : block.variant === "tip"
                  ? "border-green-500 bg-green-900/30"
                  : "border-blue-500 bg-blue-900/30";
          return (
            <div key={`block-${index}`} className={`rounded border px-3 py-2 ${variantClass}`}>
              <p className="font-semibold">{block.title}</p>
              <p className="mt-1 whitespace-pre-wrap">{block.text}</p>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

function ChatWindow({
  selectedConversationId,
  onConversationCreated,
  onConversationUpdated,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Ask me about liver disease guidelines.",
      status: "completed",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);

  const updateMessage = (id: string, updater: (message: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)));
  };

  useEffect(() => {
    return () => {
      streamControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    streamControllerRef.current?.abort();
    activeStreamIdRef.current = null;

    let cancelled = false;

    const loadConversation = async () => {
      if (!selectedConversationId) {
        if (!cancelled) {
          setLoading(false);
          setActiveConversationId(null);
          setMessages([
            {
              id: "welcome",
              role: "assistant",
              content: "Ask me about liver disease guidelines.",
              status: "completed",
            },
          ]);
        }
        return;
      }

      if (!cancelled) {
        setLoading(true);
      }

      try {
        const conversationMessages = await getConversationMessages(selectedConversationId);
        if (cancelled) {
          return;
        }

        const loadedMessages: ChatMessage[] = conversationMessages.map((message) => ({
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          content: message.content,
          status: normalizeStatus(message.status),
        }));

        setMessages(loadedMessages);
        setActiveConversationId(selectedConversationId);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : "Failed to load conversation.";
        setMessages([
          {
            id: createLocalId(),
            role: "assistant",
            content: errorMessage,
            status: "failed",
          },
        ]);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadConversation();

    return () => {
      cancelled = true;
    };
  }, [selectedConversationId]);

  const handleSendMessage = async (message: string) => {
    const userMessageId = createLocalId();
    const assistantMessageId = createLocalId();
    const streamId = createLocalId();

    const userMessage: ChatMessage = {
      id: userMessageId,
      role: "user",
      content: message,
      status: "completed",
    };
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      status: "pending",
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setLoading(true);

    const controller = new AbortController();
    streamControllerRef.current = controller;
    activeStreamIdRef.current = streamId;
    let resolvedConversationId = activeConversationId;
    try {
      await streamChatMessage(
        message,
        activeConversationId,
        {
          onMeta: ({ conversation_id }) => {
            if (activeStreamIdRef.current !== streamId || !conversation_id) {
              return;
            }
            if (!resolvedConversationId) {
              resolvedConversationId = conversation_id;
              setActiveConversationId(conversation_id);
              onConversationCreated(conversation_id);
            }
          },
          onStatus: ({ status }) => {
            if (activeStreamIdRef.current !== streamId) {
              return;
            }
            updateMessage(assistantMessageId, (prev) => ({ ...prev, status }));
          },
          onToken: ({ token }) => {
            if (activeStreamIdRef.current !== streamId) {
              return;
            }
            updateMessage(assistantMessageId, (prev) => ({
              ...prev,
              status: "streaming",
              content: prev.content + token,
            }));
          },
          onComplete: ({ conversation_id, response }) => {
            if (activeStreamIdRef.current !== streamId) {
              return;
            }
            if (!resolvedConversationId && conversation_id) {
              resolvedConversationId = conversation_id;
              setActiveConversationId(conversation_id);
              onConversationCreated(conversation_id);
            }
            updateMessage(assistantMessageId, (prev) => ({
              ...prev,
              status: "completed",
              content: response || prev.content,
            }));
          },
          onError: ({ message: errorMessage, partial_response, conversation_id }) => {
            if (activeStreamIdRef.current !== streamId) {
              return;
            }
            if (!resolvedConversationId && conversation_id) {
              resolvedConversationId = conversation_id;
              setActiveConversationId(conversation_id);
              onConversationCreated(conversation_id);
            }
            updateMessage(assistantMessageId, (prev) => ({
              ...prev,
              status: "failed",
              content: partial_response || prev.content || errorMessage,
            }));
          },
        },
        controller.signal
      );

      await onConversationUpdated();
    } catch (error) {
      if (controller.signal.aborted || activeStreamIdRef.current !== streamId) {
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "Failed to stream response from server.";
      updateMessage(assistantMessageId, (prev) => ({
        ...prev,
        status: "failed",
        content: prev.content || errorMessage,
      }));
      await onConversationUpdated();
    } finally {
      if (activeStreamIdRef.current === streamId) {
        activeStreamIdRef.current = null;
        streamControllerRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <div className="flex flex-col flex-1">
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`p-3 rounded-lg max-w-2xl ${
              message.role === "user" ? "ml-auto bg-blue-700" : "bg-neutral-700"
            }`}
          >
            {message.role === "assistant" ? (
              renderAssistantContent(message)
            ) : (
              <p className="whitespace-pre-wrap">{message.content}</p>
            )}
            {message.role === "assistant" && message.status !== "completed" && (
              <p className="mt-2 text-xs text-neutral-300 uppercase">{message.status}</p>
            )}
          </div>
        ))}
      </div>

      <ChatInput onSend={handleSendMessage} disabled={loading} />
    </div>
  );
}

export default ChatWindow;
