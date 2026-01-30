import { buildSystemPrompt } from "./tutorPrompt.js";

/**
 * Supports multiple LLM providers:
 * - Groq (GROQ_API_KEY) - Fast and cheap, recommended
 * - OpenAI (OPENAI_API_KEY) - High quality
 * - Fallback - Simple rule-based tutor (no API key needed)
 */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function tutorReply(session, userText) {
  // Prefer Groq if available (faster + cheaper), otherwise OpenAI
  if (GROQ_API_KEY) {
    return await callLLM(session, userText, {
      apiKey: GROQ_API_KEY,
      model: GROQ_MODEL,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      provider: "Groq"
    });
  }

  if (OPENAI_API_KEY) {
    return await callLLM(session, userText, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
      endpoint: "https://api.openai.com/v1/chat/completions",
      provider: "OpenAI",
      supportsJsonMode: true
    });
  }

  return fallbackTutor(userText);
}

async function callLLM(session, userText, config) {
  const system = buildSystemPrompt(session.memory);
  const messages = [
    { role: "system", content: system },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userText }
  ];

  const body = {
    model: config.model,
    messages,
    temperature: 0.4
  };

  // Only OpenAI supports response_format json_object
  if (config.supportsJsonMode) {
    body.response_format = { type: "json_object" };
  }

  try {
    const resp = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return fallbackTutor(userText, `${config.provider} error: ${resp.status} ${txt.slice(0, 120)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";

    try {
      const parsed = JSON.parse(content);
      const speech = String(parsed?.speech || "").trim();
      const notes = parsed?.notes || {};
      if (!speech) throw new Error("Empty speech");
      return { speech, notes };
    } catch (e) {
      return fallbackTutor(userText, `${config.provider} returned non-JSON or invalid schema`);
    }
  } catch (e) {
    return fallbackTutor(userText, `${config.provider} exception: ${e.message}`);
  }
}

function fallbackTutor(userText, debugNote) {
  // Simple rule-based teaching loop: respond, quick correction hint, ask a question.
  const cleaned = (userText || "").trim();
  const isEnglish = /\b(the|and|but|because|I\s|you\s|want\s|learn)\b/i.test(cleaned) && !/[àâçéèêëîïôùûüÿœ]/i.test(cleaned);

  const speech = isEnglish
    ? `Ok. Let's practice in French. Say: "Bonjour, je m'appelle ___, et aujourd'hui je veux apprendre le français." Maintenant, à toi.`
    : `D'accord. Répète après moi: "Bonjour, je m'appelle ___, et aujourd'hui je veux apprendre le français." Et toi, comment tu t'appelles ?`;

  const notes = {
    cefr_guess: "A1",
    corrections: debugNote ? [debugNote] : [],
    new_vocab: ["aujourd'hui", "apprendre"],
    next_step: "Get a self-introduction and start a short dialogue."
  };

  return { speech, notes };
}
