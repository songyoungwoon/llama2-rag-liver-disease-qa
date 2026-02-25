function Sidebar() {
  return (
    <div className="w-64 bg-neutral-800 p-4 flex flex-col">
      <h1 className="text-xl font-bold mb-6">HepaRAG</h1>

      <button className="bg-neutral-700 hover:bg-neutral-600 rounded p-2 mb-4">
        + New Chat
      </button>

      <div className="flex-1 overflow-y-auto text-sm text-neutral-400">
        <p>No chats yet</p>
      </div>
    </div>
  );
}

export default Sidebar;