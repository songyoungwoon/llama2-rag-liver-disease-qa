import { apiFetch } from "./apiConfig";

type ChatRequest = {
  message: string;
};

type ChatResponse = {
  response: string;
};

export async function sendChatMessage(message: string): Promise<string> {
  const payload: ChatRequest = { message };
  const data = await apiFetch<ChatResponse>({
    path: "/chat",
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data.response;
}
