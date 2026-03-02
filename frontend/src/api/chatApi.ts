import { API_BASE_URL } from "./apiConfig";

type ChatRequest = {
  message: string;
  conversation_id: string | null;
};

export type MessageStatus = "pending" | "streaming" | "completed" | "failed";

type StreamMetaPayload = {
  conversation_id: string;
};

type StreamStatusPayload = {
  status: MessageStatus;
};

type StreamTokenPayload = {
  token: string;
};

type StreamCompletePayload = {
  conversation_id: string;
  response: string;
};

type StreamErrorPayload = {
  message: string;
  partial_response?: string;
  conversation_id?: string;
};

type StreamChatHandlers = {
  onMeta?: (payload: StreamMetaPayload) => void;
  onStatus?: (payload: StreamStatusPayload) => void;
  onToken?: (payload: StreamTokenPayload) => void;
  onComplete?: (payload: StreamCompletePayload) => void;
  onError?: (payload: StreamErrorPayload) => void;
};

function parseSseEvent(rawEvent: string): { event: string; data: string } | null {
  const lines = rawEvent.replace(/\r/g, "").split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      const dataValue = line.slice(5);
      dataLines.push(dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join("\n") };
}

function handleSseEvent(
  parsedEvent: { event: string; data: string },
  handlers: StreamChatHandlers
) {
  const payload = JSON.parse(parsedEvent.data) as Record<string, unknown>;

  if (parsedEvent.event === "meta") {
    handlers.onMeta?.({ conversation_id: String(payload.conversation_id ?? "") });
    return;
  }

  if (parsedEvent.event === "status") {
    handlers.onStatus?.({ status: payload.status as MessageStatus });
    return;
  }

  if (parsedEvent.event === "token") {
    handlers.onToken?.({ token: String(payload.token ?? "") });
    return;
  }

  if (parsedEvent.event === "completed") {
    handlers.onComplete?.({
      conversation_id: String(payload.conversation_id ?? ""),
      response: String(payload.response ?? ""),
    });
    return;
  }

  if (parsedEvent.event === "error") {
    handlers.onError?.({
      message: String(payload.message ?? "Streaming failed"),
      partial_response:
        payload.partial_response === undefined ? undefined : String(payload.partial_response),
      conversation_id:
        payload.conversation_id === undefined ? undefined : String(payload.conversation_id),
    });
  }
}

export async function streamChatMessage(
  message: string,
  conversationId: string | null,
  handlers: StreamChatHandlers,
  signal?: AbortSignal
) {
  const payload: ChatRequest = { message, conversation_id: conversationId };
  const response = await fetch(`${API_BASE_URL}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Streaming request failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Streaming response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      if (rawEvent.trim()) {
        const parsedEvent = parseSseEvent(rawEvent);
        if (parsedEvent) {
          handleSseEvent(parsedEvent, handlers);
        }
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }
}
