import { useEffect, useState } from "react";
import ChatInput from "./ChatInput";
import { sendChatMessage } from "../api/chatApi";
import { getConversationMessages } from "../api/conversationApi";

type Message = {
  role: "assistant" | "user";
  content: string;
};

type ChatWindowProps = {
  selectedConversationId: string | null;
  onConversationCreated: (conversationId: string) => void;
  onConversationUpdated: () => void | Promise<void>;
};

function ChatWindow({
  selectedConversationId,
  onConversationCreated,
  onConversationUpdated,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Ask me about liver disease guidelines." },
  ]);
  const [loading, setLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadConversation = async () => {
      if (!selectedConversationId) {
        if (!cancelled) {
          setActiveConversationId(null);
          setMessages([{ role: "assistant", content: "Ask me about liver disease guidelines." }]);
        }
        return;
      }

      if (!cancelled) {
        setLoading(true);
      }
      try {
        const conversationMessages = await getConversationMessages(selectedConversationId);
        const loadedMessages: Message[] = conversationMessages.map((message) => ({
          role: message.role === "user" ? "user" : "assistant",
          content: message.content,
        }));
        if (!cancelled) {
          setMessages(loadedMessages);
          setActiveConversationId(selectedConversationId);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to load conversation.";
        if (!cancelled) {
          setMessages([{ role: "assistant", content: errorMessage }]);
        }
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
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setLoading(true);

    try {
      const data = await sendChatMessage(message, activeConversationId);
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);

      if (!activeConversationId) {
        setActiveConversationId(data.conversation_id);
        onConversationCreated(data.conversation_id);
      }
      await onConversationUpdated();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to get response from server.";
      setMessages((prev) => [...prev, { role: "assistant", content: errorMessage }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1">
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`p-3 rounded-lg max-w-2xl ${
              message.role === "user" ? "ml-auto bg-blue-700" : "bg-neutral-700"
            }`}
          >
            {message.content}
          </div>
        ))}
        {loading && <div className="bg-neutral-700 p-3 rounded-lg max-w-2xl">Thinking...</div>}
      </div>

      <ChatInput onSend={handleSendMessage} disabled={loading} />
    </div>
  );
}

export default ChatWindow;
