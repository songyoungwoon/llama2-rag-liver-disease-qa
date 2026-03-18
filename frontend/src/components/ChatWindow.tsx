import { useEffect, useMemo, useRef, useState } from "react";
import { streamChatMessage, type MessageStatus, type RagSource } from "../api/chatApi";
import { getConversationMessages } from "../api/conversationApi";
import ChatInput from "./ChatInput";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  status: MessageStatus;
  sources?: RagSource[];
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

type DraftPreview = {
  text: string;
  kind: "text" | "code" | "list";
};

type RichResponsePartial = {
  blocks: RichBlock[];
  draft?: DraftPreview;
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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMatrix = (value: unknown): value is string[][] =>
  Array.isArray(value) && value.every((row) => isStringArray(row));

function normalizeBlock(block: Record<string, unknown>): RichBlock | null {
  if (block.type === "title" && typeof block.text === "string") {
    return { type: "title", text: block.text };
  }

  if (
    block.type === "heading" &&
    typeof block.text === "string" &&
    typeof block.level === "number" &&
    Number.isInteger(block.level) &&
    block.level >= 1 &&
    block.level <= 4
  ) {
    return {
      type: "heading",
      level: block.level,
      text: block.text,
    };
  }

  if (block.type === "paragraph" && typeof block.text === "string") {
    return { type: "paragraph", text: block.text };
  }

  if (block.type === "list" && typeof block.ordered === "boolean" && isStringArray(block.items)) {
    return {
      type: "list",
      ordered: block.ordered,
      items: block.items,
    };
  }

  if (block.type === "code" && typeof block.language === "string" && typeof block.code === "string") {
    return {
      type: "code",
      language: block.language,
      code: block.code,
    };
  }

  if (block.type === "table" && isStringArray(block.headers) && isStringMatrix(block.rows)) {
    return {
      type: "table",
      headers: block.headers,
      rows: block.rows,
    };
  }

  if (block.type === "quote" && typeof block.text === "string") {
    return { type: "quote", text: block.text };
  }

  if (
    block.type === "callout" &&
    (block.variant === "info" ||
      block.variant === "tip" ||
      block.variant === "warning" ||
      block.variant === "caution") &&
    typeof block.title === "string" &&
    typeof block.text === "string"
  ) {
    const variant = block.variant as RichCalloutBlock["variant"];
    return {
      type: "callout",
      variant,
      title: block.title,
      text: block.text,
    };
  }

  return null;
}

function normalizeBlocks(blocks: unknown[]): RichBlock[] {
  const normalized: RichBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      continue;
    }
    const normalizedBlock = normalizeBlock(block as Record<string, unknown>);
    if (normalizedBlock) {
      normalized.push(normalizedBlock);
    }
  }
  return normalized;
}

function parseRichResponse(content: string): RichResponse | null {
  try {
    const parsed = JSON.parse(content) as { blocks?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) {
      return null;
    }
    const normalizedBlocks = normalizeBlocks(parsed.blocks);
    return { blocks: normalizedBlocks };
  } catch {
    return null;
  }
}

function decodeSimpleEscape(ch: string): string {
  if (ch === "n") {
    return "\n";
  }
  if (ch === "r") {
    return "\r";
  }
  if (ch === "t") {
    return "\t";
  }
  if (ch === "b") {
    return "\b";
  }
  if (ch === "f") {
    return "\f";
  }
  if (ch === "\\") {
    return "\\";
  }
  if (ch === "\"") {
    return "\"";
  }
  if (ch === "/") {
    return "/";
  }
  return ch;
}

function extractStringValue(partial: string, key: string): string | null {
  const keyIndex = partial.lastIndexOf(`"${key}"`);
  if (keyIndex === -1) {
    return null;
  }
  const colonIndex = partial.indexOf(":", keyIndex + key.length + 2);
  if (colonIndex === -1) {
    return null;
  }
  const firstQuote = partial.indexOf("\"", colonIndex + 1);
  if (firstQuote === -1) {
    return null;
  }

  let result = "";
  let escape = false;

  for (let i = firstQuote + 1; i < partial.length; i += 1) {
    const ch = partial[i];
    if (escape) {
      if (ch === "u") {
        const hex = partial.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          result += "u";
        }
      } else {
        result += decodeSimpleEscape(ch);
      }
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === "\"") {
      return result;
    }

    result += ch;
  }

  return result;
}

function extractStringArrayValues(partial: string, key: string): string[] {
  const keyIndex = partial.lastIndexOf(`"${key}"`);
  if (keyIndex === -1) {
    return [];
  }
  const arrayStart = partial.indexOf("[", keyIndex + key.length + 2);
  if (arrayStart === -1) {
    return [];
  }

  const values: string[] = [];
  let inString = false;
  let escape = false;
  let current = "";

  for (let i = arrayStart + 1; i < partial.length; i += 1) {
    const ch = partial[i];

    if (inString) {
      if (escape) {
        if (ch === "u") {
          const hex = partial.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            current += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            current += "u";
          }
        } else {
          current += decodeSimpleEscape(ch);
        }
        escape = false;
        continue;
      }

      if (ch === "\\") {
        escape = true;
        continue;
      }

      if (ch === "\"") {
        values.push(current);
        current = "";
        inString = false;
        continue;
      }

      current += ch;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      current = "";
      continue;
    }

    if (ch === "]") {
      break;
    }
  }

  if (inString && current) {
    values.push(current);
  }

  return values;
}

function extractDraftPreviewFromBlock(blockText: string): DraftPreview | null {
  const blockType = extractStringValue(blockText, "type");
  if (!blockType) {
    return null;
  }

  if (blockType === "code") {
    const code = extractStringValue(blockText, "code");
    if (!code) {
      return null;
    }
    return { text: code, kind: "code" };
  }

  if (blockType === "list") {
    const items = extractStringArrayValues(blockText, "items");
    if (items.length === 0) {
      return null;
    }
    return { text: items[items.length - 1], kind: "list" };
  }

  let text = extractStringValue(blockText, "text");
  if (!text && blockType === "callout") {
    text = extractStringValue(blockText, "title");
  }
  if (!text) {
    return null;
  }
  return { text, kind: "text" };
}

function parseRichResponsePartial(content: string): RichResponsePartial | null {
  const blocksKeyIndex = content.indexOf("\"blocks\"");
  if (blocksKeyIndex === -1) {
    return null;
  }

  const arrayStart = content.indexOf("[", blocksKeyIndex);
  if (arrayStart === -1) {
    return null;
  }

  const blocks: RichBlock[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let blockStart = -1;

  for (let i = arrayStart + 1; i < content.length; i += 1) {
    const ch = content[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (blockStart === -1) {
      if (ch === "{") {
        blockStart = i;
        depth = 1;
      } else if (ch === "]") {
        break;
      }
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const blockText = content.slice(blockStart, i + 1);
        blockStart = -1;
        try {
          const parsedBlock = JSON.parse(blockText) as Record<string, unknown>;
          const normalizedBlock = normalizeBlock(parsedBlock);
          if (normalizedBlock) {
            blocks.push(normalizedBlock);
          }
        } catch {
          // Ignore malformed partial blocks
        }
      }
    }
  }

  let draft: DraftPreview | undefined;
  if (blockStart !== -1) {
    draft = extractDraftPreviewFromBlock(content.slice(blockStart));
  }

  if (blocks.length === 0 && !draft) {
    return null;
  }

  return { blocks, draft };
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

function renderSources(sources: RagSource[]) {
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <details className="rounded border border-neutral-600 bg-neutral-800/50 px-3 py-2">
      <summary className="cursor-pointer text-sm text-neutral-200">
        Sources ({sources.length})
      </summary>
      <div className="mt-2 space-y-2 text-sm">
        {sources.map((source, index) => (
          <div key={`source-${index}`} className="rounded border border-neutral-700 bg-neutral-900/40 px-3 py-2">
            <p className="font-semibold">{source.title || "Untitled"}</p>
            <p className="text-xs text-neutral-300">{source.source || "unknown"}</p>
            {typeof source.score === "number" ? (
              <p className="text-xs text-neutral-400">score: {source.score.toFixed(3)}</p>
            ) : null}
            {source.content ? (
              <p className="mt-1 whitespace-pre-wrap">{source.content}</p>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function renderBlocks(blocks: RichBlock[]) {
  return (
    <>
      {blocks.map((block, index) => {
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
    </>
  );
}

function useTypewriter(target: string, enabled: boolean, speedMs: number = 16) {
  const [display, setDisplay] = useState("");

  useEffect(() => {
    if (!enabled) {
      setDisplay(target);
      return;
    }

    if (target.length < display.length) {
      setDisplay(target);
      return;
    }

    if (display.length >= target.length) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setDisplay(target.slice(0, display.length + 1));
    }, speedMs);

    return () => window.clearTimeout(timeout);
  }, [target, enabled, speedMs, display]);

  return display;
}

function renderDraftPreview(text: string, kind: DraftPreview["kind"]) {
  if (kind === "code") {
    return (
      <pre className="p-3 text-sm overflow-x-auto rounded border border-neutral-600 bg-neutral-900">
        <code>{text}</code>
      </pre>
    );
  }

  if (kind === "list") {
    return <p className="whitespace-pre-wrap">- {text}</p>;
  }

  return <p className="whitespace-pre-wrap text-neutral-100/80">{text}</p>;
}

function AssistantContent({ message }: { message: ChatMessage }) {
  const parsed = useMemo(() => parseRichResponse(message.content), [message.content]);
  const partial = useMemo(() => parseRichResponsePartial(message.content), [message.content]);

  const hasFullBlocks = Boolean(parsed && parsed.blocks.length > 0);
  const blocks = hasFullBlocks ? parsed!.blocks : partial?.blocks ?? [];
  const draft = !hasFullBlocks ? partial?.draft : undefined;
  const draftText = draft?.text ?? "";
  const typingEnabled = message.status !== "completed" && draftText.length > 0;
  const typedDraft = useTypewriter(draftText, typingEnabled, 16);
  const sources = message.sources ?? [];

  if (blocks.length === 0 && !typedDraft) {
    return (
      <div className="space-y-3">
        {renderSources(sources)}
        <p className="whitespace-pre-wrap">
          {message.content || (message.status === "pending" ? "Thinking..." : "")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {renderSources(sources)}
      {blocks.length > 0 ? renderBlocks(blocks) : null}
      {typedDraft ? renderDraftPreview(typedDraft, draft?.kind ?? "text") : null}
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
          onRag: ({ sources }) => {
            if (activeStreamIdRef.current !== streamId) {
              return;
            }
            updateMessage(assistantMessageId, (prev) => ({
              ...prev,
              sources,
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
              <AssistantContent message={message} />
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





