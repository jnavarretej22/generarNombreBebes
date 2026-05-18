// ══════════════════════════════════════════════════════
// SWITCH DE PROVEEDOR
// Cambia a true/false según el proveedor que quieras usar.
// Solo uno debe estar en true a la vez.
// ══════════════════════════════════════════════════════
const ACTIVAR_GEMINI = true;
const ACTIVAR_GROQ   = false;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, temperature, max_tokens, response_format } = req.body;

  try {
    if (ACTIVAR_GEMINI) {
      return await callGemini({ res, messages, temperature, max_tokens });
    }
    if (ACTIVAR_GROQ) {
      return await callGroq({ res, messages, temperature, max_tokens, response_format });
    }
    return res.status(500).json({ error: 'Ningún proveedor activo. Revisa el switch en generate.js.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ══════════════════════════════════════════════════════
// GEMINI
// ══════════════════════════════════════════════════════
async function callGemini({ res, messages, temperature, max_tokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model  = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor.' });
  }

  // Convierte el formato OpenAI (messages) al formato Gemini
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsg   = messages.find(m => m.role === 'user');

  const body = {
    system_instruction: systemMsg
      ? { parts: [{ text: systemMsg.content }] }
      : undefined,
    contents: [{ role: 'user', parts: [{ text: userMsg?.content || '' }] }],
    generationConfig: {
      temperature:     temperature ?? 1.0,
      maxOutputTokens: max_tokens  ?? 2000,
      responseMimeType: 'application/json',
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await geminiRes.json();

  if (!geminiRes.ok) {
    return res.status(geminiRes.status).json(data);
  }

  // Adapta la respuesta de Gemini al formato OpenAI que espera el frontend
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return res.status(200).json({
    choices: [{ message: { role: 'assistant', content: text } }],
  });
}

// ══════════════════════════════════════════════════════
// GROQ (en espera por si se acaban créditos de Gemini)
// Para activar: ACTIVAR_GROQ = true  /  ACTIVAR_GEMINI = false
// ══════════════════════════════════════════════════════
async function callGroq({ res, messages, temperature, max_tokens, response_format }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model  = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada en el servidor.' });
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens, response_format }),
  });

  const data = await groqRes.json();

  if (!groqRes.ok) {
    return res.status(groqRes.status).json(data);
  }

  return res.status(200).json(data);
}
