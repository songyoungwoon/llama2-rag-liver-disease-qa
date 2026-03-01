import { useCallback, useEffect, useState } from "react";
import { getConversations, type ConversationSummary } from "./api/conversationApi";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";

function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await getConversations();
      setConversations(data);
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const handleNewChat = () => {
    setSelectedConversationId(null);
  };

  const handleConversationChange = (conversationId: string) => {
    setSelectedConversationId(conversationId);
  };

  return (
    <div className="flex h-screen bg-neutral-900 text-white">
      <Sidebar
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        onSelectConversation={handleConversationChange}
        onNewChat={handleNewChat}
      />
      <ChatWindow
        selectedConversationId={selectedConversationId}
        onConversationCreated={handleConversationChange}
        onConversationUpdated={loadConversations}
      />
    </div>
  );
}

export default App;
