/**
 * Local Gemma via Ollama HTTP API (no Google API key).
 * Prerequisites: Ollama installed and `ollama pull <model>` (e.g. gemma2:2b).
 * Run: npm run gemma:ollama
 */
import "dotenv/config";

const host = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(
  /\/$/,
  ""
);
const model = process.env.OLLAMA_MODEL?.trim() || "gemma2:2b";

type OllamaChatResponse = {
  message?: { content?: string };
  error?: string;
};

async function main() {
  const url = `${host}/api/chat`;
  const body = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: ok-gemma-ollama" }],
    stream: false,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ollama ${r.status}: ${t}`);
  }

  const data = (await r.json()) as OllamaChatResponse;
  if (data.error) throw new Error(data.error);

  console.log("host:", host);
  console.log("model:", model);
  console.log("response:", data.message?.content?.trim() ?? "");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
