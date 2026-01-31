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
      provider: "Groq",
      requiresJsonInstructions: true  // Groq needs explicit JSON instructions
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

  // For Groq, we need to add explicit JSON formatting instruction at the end
  const userMessage = config.requiresJsonInstructions
    ? `${userText}\n\nIMPORTANT: You must respond with ONLY valid JSON in the exact schema specified. No markdown, no explanations, just raw JSON.`
    : userText;

  const messages = [
    { role: "system", content: system },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage }
  ];

  const body = {
    model: config.model,
    messages,
    temperature: 0.7  // Increased for more natural responses
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

    console.log('[LLM Response]:', content.slice(0, 300));

    // Try to extract JSON from markdown code blocks if present
    let jsonContent = content;
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      console.log('[LLM] Extracted JSON from markdown code block');
      jsonContent = jsonMatch[1];
    }

    try {
      const parsed = JSON.parse(jsonContent);
      const speech = String(parsed?.speech || "").trim();
      const notes = parsed?.notes || {};

      if (!speech) {
        console.error('[LLM] Empty speech field in response');
        throw new Error("Empty speech");
      }

      console.log('[LLM] Successfully parsed response, speech length:', speech.length);
      return { speech, notes };
    } catch (e) {
      console.error('[LLM Parse Error]:', e.message);
      console.error('[LLM Parse Error] Full content:', content);
      return fallbackTutor(userText, `${config.provider} returned non-JSON or invalid schema`);
    }
  } catch (e) {
    console.error('[LLM Exception]:', e.message);
    return fallbackTutor(userText, `${config.provider} exception: ${e.message}`);
  }
}

function fallbackTutor(userText, debugNote) {
  console.log('[Fallback Tutor] Activated. User said:', userText);
  console.log('[Fallback Tutor] Debug note:', debugNote || 'none');

  // Simple rule-based teaching loop: respond, quick correction hint, ask a question.
  const cleaned = (userText || "").trim().toLowerCase();
  const isEnglish = /\b(the|and|but|because|i\s|you\s|want\s|learn|hello|hi)\b/i.test(cleaned) && !/[àâçéèêëîïôùûüÿœ]/i.test(cleaned);

  let speech;
  let vocabulary = [];

  // Check for common greetings
  if (cleaned.includes('bonjour') || cleaned.includes('hello') || cleaned.includes('hi')) {
    speech = `Bonjour! Je suis votre tuteur de français. Comment allez-vous aujourd'hui? Dites-moi: "Je vais bien, merci" qui veut dire "I'm fine, thank you".`;
    vocabulary = [
      { french: "bonjour", english: "hello", pronunciation: "bon-ZHOOR", example: "Bonjour! Comment allez-vous?" },
      { french: "comment allez-vous", english: "how are you", pronunciation: "koh-mohn tah-lay-VOO", example: "Bonjour, comment allez-vous?" }
    ];
  } else if (cleaned.includes('bien') || cleaned.includes('fine') || cleaned.includes('good')) {
    speech = `Très bien! Excellent! Maintenant, présentons-nous. Je m'appelle Ami. Et vous, comment vous appelez-vous? Say: "Je m'appelle" followed by your name.`;
    vocabulary = [
      { french: "très bien", english: "very good", pronunciation: "treh bee-AN", example: "Je vais très bien, merci!" },
      { french: "je m'appelle", english: "my name is", pronunciation: "zhuh mah-PELL", example: "Je m'appelle Marie." }
    ];
  } else if (isEnglish) {
    speech = `Hello! I'm your French tutor. Let's start with a simple greeting. Try saying: "Bonjour" which means "Hello" in French. Go ahead, say "Bonjour"!`;
    vocabulary = [
      { french: "bonjour", english: "hello", pronunciation: "bon-ZHOOR", example: "Bonjour! Comment ça va?" },
      { french: "français", english: "French", pronunciation: "fron-SAY", example: "Je parle français." }
    ];
  } else {
    speech = `Bien! Je vois que vous essayez de parler français. C'est excellent! Let me teach you some basics. Répétez après moi: "Je veux apprendre le français" which means "I want to learn French".`;
    vocabulary = [
      { french: "je veux", english: "I want", pronunciation: "zhuh vuh", example: "Je veux apprendre." },
      { french: "apprendre", english: "to learn", pronunciation: "ah-PRON-druh", example: "Je veux apprendre le français." }
    ];
  }

  const notes = {
    cefr_guess: "A1",
    corrections: debugNote ? [debugNote] : [],
    vocabulary: vocabulary,
    new_vocab: vocabulary.map(v => v.french),
    lesson_progress: {
      current_step: 1,
      total_steps: 5,
      step_title: "First Greetings",
      next_objective: "Practice basic French greetings and introductions"
    },
    next_step: "Practice pronunciation and build confidence"
  };

  console.log('[Fallback Tutor] Responding with speech:', speech.slice(0, 100));

  return { speech, notes };
}
