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
            <p>{message.content || (message.status === "pending" ? "Thinking..." : "")}</p>
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
