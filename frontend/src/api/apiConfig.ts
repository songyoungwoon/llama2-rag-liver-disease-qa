const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

type ApiFetchOptions = RequestInit & {
  path: string;
};

export async function apiFetch<T>({ path, ...options }: ApiFetchOptions): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `API request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export { API_BASE_URL };
