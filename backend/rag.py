import os
import threading
from typing import Iterable, List

import numpy as np
from llama_cpp import Llama

MODEL_PATH = os.getenv("EMBED_MODEL_PATH", "/app/models/bge-m3-Q5_K_M.gguf")
N_CTX = int(os.getenv("EMBED_N_CTX", "512"))
N_GPU_LAYERS = int(os.getenv("EMBED_N_GPU_LAYERS", "35"))
N_THREADS = int(os.getenv("EMBED_N_THREADS", "8"))
NORMALIZE = os.getenv("EMBED_NORMALIZE", "true").lower() in {"1", "true", "yes"}

_embedder: Llama | None = None
_embed_lock = threading.Lock()


def get_embedder() -> Llama:
    global _embedder
    if _embedder is None:
        with _embed_lock:
            if _embedder is None:
                _embedder = Llama(
                    model_path=MODEL_PATH,
                    n_ctx=N_CTX,
                    n_gpu_layers=N_GPU_LAYERS,
                    n_threads=N_THREADS,
                    embedding=True,
                    verbose=False,
                )
    return _embedder


def normalize_embedding(vector: Iterable[float]) -> np.ndarray:
    arr = np.asarray(list(vector), dtype=np.float32)
    if arr.size == 0:
        return arr
    norm = np.linalg.norm(arr)
    if norm == 0:
        return arr
    return arr / norm


def embed_text(text: str) -> List[float]:
    llm = get_embedder()
    raw = llm.embed(text)
    if isinstance(raw, list) and raw and isinstance(raw[0], list):
        raw = raw[0]

    if NORMALIZE:
        return normalize_embedding(raw).tolist()
    return list(raw)


def cosine_sim(a: Iterable[float], b: Iterable[float]) -> float:
    vec_a = normalize_embedding(a)
    vec_b = normalize_embedding(b)
    if vec_a.size == 0 or vec_b.size == 0:
        return 0.0
    return float(np.dot(vec_a, vec_b))


def mmr_select(
    query_vec: Iterable[float],
    candidates: List[dict],
    top_k: int,
    lambda_param: float,
) -> List[dict]:
    if top_k <= 0 or not candidates:
        return []

    lambda_param = max(0.0, min(1.0, lambda_param))
    query = normalize_embedding(query_vec)
    candidate_vecs = [normalize_embedding(c["embedding"]) for c in candidates]

    selected: List[dict] = []
    selected_indices: set[int] = set()

    while len(selected) < min(top_k, len(candidates)):
        best_idx = None
        best_score = None

        for idx, candidate in enumerate(candidates):
            if idx in selected_indices:
                continue

            sim_to_query = candidate["score"]
            if not selected:
                mmr_score = sim_to_query
            else:
                max_sim_to_selected = max(
                    float(np.dot(candidate_vecs[idx], candidate_vecs[s_idx]))
                    for s_idx in selected_indices
                )
                mmr_score = (lambda_param * sim_to_query) - ((1 - lambda_param) * max_sim_to_selected)

            if best_score is None or mmr_score > best_score:
                best_score = mmr_score
                best_idx = idx

        if best_idx is None:
            break

        chosen = candidates[best_idx]
        chosen["mmr_score"] = float(best_score) if best_score is not None else None
        selected.append(chosen)
        selected_indices.add(best_idx)

    return selected
