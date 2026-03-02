from llama_cpp import Llama
import warnings

try:
    from llama_cpp import LlamaGrammar
except ImportError:
    LlamaGrammar = None


SYSTEM_PROMPT = """You are a clinical assistant for liver disease QA.
Always return only one JSON object with this exact schema:
{
  "blocks": [
    {"type":"title","text":"..."},
    {"type":"heading","level":2,"text":"..."},
    {"type":"paragraph","text":"..."},
    {"type":"list","ordered":false,"items":["..."]},
    {"type":"code","language":"text","code":"..."},
    {"type":"table","headers":["..."],"rows":[["..."]]},
    {"type":"quote","text":"..."},
    {"type":"callout","variant":"info","title":"...","text":"..."}
  ]
}
Rules:
- Output must be valid JSON.
- Do not output markdown, code fences, explanation text, or keys outside each block schema.
- Use only the supported block types: title, heading, paragraph, list, code, table, quote, callout.
- Keep the answer medically cautious and easy to read.
"""


JSON_RESPONSE_GBNF = r"""
root ::= ws object ws
object ::= "{" ws "\"blocks\"" ws ":" ws "[" ws "]" ws "}" | "{" ws "\"blocks\"" ws ":" ws "[" ws blocklist ws "]" ws "}"
blocklist ::= block (ws "," ws block)*
block ::= titleblock | headingblock | paragraphblock | listblock | codeblock | tableblock | quoteblock | calloutblock

titleblock ::= "{" ws "\"type\"" ws ":" ws "\"title\"" ws "," ws "\"text\"" ws ":" ws string ws "}"
headingblock ::= "{" ws "\"type\"" ws ":" ws "\"heading\"" ws "," ws "\"level\"" ws ":" ws headinglevel ws "," ws "\"text\"" ws ":" ws string ws "}"
paragraphblock ::= "{" ws "\"type\"" ws ":" ws "\"paragraph\"" ws "," ws "\"text\"" ws ":" ws string ws "}"
listblock ::= "{" ws "\"type\"" ws ":" ws "\"list\"" ws "," ws "\"ordered\"" ws ":" ws boolean ws "," ws "\"items\"" ws ":" ws stringarray ws "}"
codeblock ::= "{" ws "\"type\"" ws ":" ws "\"code\"" ws "," ws "\"language\"" ws ":" ws string ws "," ws "\"code\"" ws ":" ws string ws "}"
tableblock ::= "{" ws "\"type\"" ws ":" ws "\"table\"" ws "," ws "\"headers\"" ws ":" ws stringarray ws "," ws "\"rows\"" ws ":" ws rowsarray ws "}"
quoteblock ::= "{" ws "\"type\"" ws ":" ws "\"quote\"" ws "," ws "\"text\"" ws ":" ws string ws "}"
calloutblock ::= "{" ws "\"type\"" ws ":" ws "\"callout\"" ws "," ws "\"variant\"" ws ":" ws calloutvariant ws "," ws "\"title\"" ws ":" ws string ws "," ws "\"text\"" ws ":" ws string ws "}"

headinglevel ::= "1" | "2" | "3" | "4"
calloutvariant ::= "\"info\"" | "\"tip\"" | "\"warning\"" | "\"caution\""
boolean ::= "true" | "false"

rowsarray ::= "[" ws "]" | "[" ws stringarraylist ws "]"
stringarraylist ::= stringarray (ws "," ws stringarray)*
stringarray ::= "[" ws "]" | "[" ws stringlist ws "]"
stringlist ::= string (ws "," ws string)*

string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1F] | "\\" escape
escape ::= ["\\/bfnrt] | "u" hex hex hex hex
hex ::= [0-9a-fA-F]
ws ::= [ \t\n\r]*
"""


def _build_grammar():
    if LlamaGrammar is None:
        return None
    try:
        return LlamaGrammar.from_string(JSON_RESPONSE_GBNF)
    except Exception as exc:
        warnings.warn(
            f"Failed to parse GBNF grammar. Falling back to unconstrained generation: {exc}",
            RuntimeWarning,
        )
        return None


JSON_GRAMMAR = _build_grammar()


llm = Llama(
    model_path="/app/models/llama-2-7b-chat.Q4_K_M.gguf",
    n_gpu_layers=35,
    n_ctx=4096,
    n_threads=8,
)


def _format_prompt(user_prompt: str) -> str:
    return (
        "[INST] <<SYS>>\n"
        f"{SYSTEM_PROMPT}\n"
        "<</SYS>>\n\n"
        f"{user_prompt}\n"
        "[/INST]"
    )


def _llm_kwargs(user_prompt: str):
    kwargs = {
        "prompt": _format_prompt(user_prompt),
        "max_tokens": 512,
        "temperature": 0.2,
        "top_p": 0.9,
        "stop": ["</s>"],
    }
    if JSON_GRAMMAR is not None:
        kwargs["grammar"] = JSON_GRAMMAR
    return kwargs


def generate_response_stream(user_prompt: str):
    return llm(
        stream=True,
        **_llm_kwargs(user_prompt),
    )


def generate_response(user_prompt: str):
    chunks = []
    for chunk in generate_response_stream(user_prompt):
        token = chunk["choices"][0]["text"]
        if token:
            chunks.append(token)
    return "".join(chunks)
