import { useState } from "react";
import ChatInput from "./ChatInput";
import { sendChatMessage } from "../api/chatApi";

type Message = {
  role: "assistant" | "user";
  content: string;
};

function ChatWindow() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Ask me about liver disease guidelines." },
  ]);
  const [loading, setLoading] = useState(false);

  const handleSendMessage = async (message: string) => {
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setLoading(true);

    try {
      const response = await sendChatMessage(message);
      setMessages((prev) => [...prev, { role: "assistant", content: response }]);
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
