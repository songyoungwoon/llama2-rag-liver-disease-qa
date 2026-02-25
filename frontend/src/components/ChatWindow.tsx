import ChatInput from "./ChatInput";

function ChatWindow() {
  return (
    <div className="flex flex-col flex-1">
      
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="bg-neutral-700 p-3 rounded-lg max-w-2xl">
          Ask me about liver disease guidelines.
        </div>
      </div>

      <ChatInput />
    </div>
  );
}

export default ChatWindow;