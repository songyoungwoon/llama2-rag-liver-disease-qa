import { apiFetch } from "./apiConfig";

type ChatRequest = {
  message: string;
  conversation_id: string | null;
};

type ChatResponse = {
  conversation_id: string;
  response: string;
};

export async function sendChatMessage(
  message: string,
  conversationId: string | null
): Promise<ChatResponse> {
  const payload: ChatRequest = { message, conversation_id: conversationId };
  return apiFetch<ChatResponse>({
    path: "/chat",
    method: "POST",
    body: JSON.stringify(payload),
  });
}
