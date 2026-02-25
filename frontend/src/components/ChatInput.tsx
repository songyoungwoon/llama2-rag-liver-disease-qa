import { useState } from "react";

function ChatInput() {
  const [message, setMessage] = useState("");

  const handleSend = () => {
    console.log(message);
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
        />
        <button
          onClick={handleSend}
          className="bg-blue-600 hover:bg-blue-500 px-4 rounded-lg"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatInput;