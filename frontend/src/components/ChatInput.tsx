import { useState } from "react";

type ChatInputProps = {
  onSend: (message: string) => void | Promise<void>;
  disabled?: boolean;
};

function ChatInput({ onSend, disabled = false }: ChatInputProps) {
  const [message, setMessage] = useState("");

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || disabled) {
      return;
    }

    await onSend(trimmedMessage);
    setMessage("");
  };

  return (
    <div className="p-4 border-t border-neutral-700">
      <div className="flex gap-2">
        <input
          className="flex-1 bg-neutral-800 p-3 rounded-lg outline-none"
          placeholder="Ask about liver disease guidelines..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void handleSend();
            }
          }}
          disabled={disabled}
        />
        <button
          onClick={() => void handleSend()}
          disabled={disabled}
          className="bg-blue-600 hover:bg-blue-500 px-4 rounded-lg"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatInput;
