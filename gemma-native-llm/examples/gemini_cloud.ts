/**
 * Minimal Gemini API call via @google/genai (cloud).
 * Run: npm run gemini:cloud  (from this directory, after npm install)
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("Set GEMINI_API_KEY in .env (see .env.example).");
  process.exit(1);
}

const model =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";

async function main() {
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ text: "Reply with exactly: ok-gemini-cloud" }],
      },
    ],
  });

  const text = res.text?.trim() ?? "";
  console.log("model:", model);
  console.log("response:", text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
