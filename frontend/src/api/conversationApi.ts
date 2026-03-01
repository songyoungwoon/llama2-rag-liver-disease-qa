import { apiFetch } from "./apiConfig";

export type ConversationSummary = {
  id: string;
  title: string | null;
  message_count: number;
};

export type ConversationMessage = {
  id: string;
  role: "assistant" | "user" | string;
  content: string;
  status: string | null;
  sequence_number: number;
};

export async function getConversations(): Promise<ConversationSummary[]> {
  return apiFetch<ConversationSummary[]>({
    path: "/conversations",
    method: "GET",
  });
}

export async function getConversationMessages(
  conversationId: string
): Promise<ConversationMessage[]> {
  return apiFetch<ConversationMessage[]>({
    path: `/conversations/${conversationId}/messages`,
    method: "GET",
  });
}
