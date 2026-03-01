import type { ConversationSummary } from "../api/conversationApi";

type SidebarProps = {
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onNewChat: () => void;
};

function Sidebar({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewChat,
}: SidebarProps) {
  return (
    <div className="w-64 bg-neutral-800 p-4 flex flex-col">
      <h1 className="text-xl font-bold mb-6">HepaRAG</h1>

      <button
        onClick={onNewChat}
        className="bg-neutral-700 hover:bg-neutral-600 rounded p-2 mb-4"
      >
        + New Chat
      </button>

      <div className="flex-1 overflow-y-auto text-sm text-neutral-400">
        {conversations.length === 0 ? (
          <p>No chats yet</p>
        ) : (
          <div className="space-y-2">
            {conversations.map((conversation) => {
              const isSelected = selectedConversationId === conversation.id;
              return (
                <button
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                  className={`w-full text-left rounded p-2 transition-colors ${
                    isSelected
                      ? "bg-neutral-600 text-white"
                      : "bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
                  }`}
                >
                  {conversation.title || "Untitled chat"}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
