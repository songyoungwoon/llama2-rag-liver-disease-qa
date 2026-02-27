from llama_cpp import Llama

llm = Llama(
    model_path="/app/models/llama-2-7b-chat.Q4_K_M.gguf",
    n_gpu_layers=35,  # GPU offload (3060Ti 적정값)
    n_ctx=4096,
    n_threads=8
)

def generate_response(prompt: str):
    output = llm(
        prompt,
        max_tokens=512,
        temperature=0.7,
        top_p=0.9,
        stop=["</s>"]
    )
    return output["choices"][0]["text"]