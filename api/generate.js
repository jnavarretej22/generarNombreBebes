// ══════════════════════════════════════════════════════
// SWITCH DE PROVEEDOR PRIMARIO
// Solo uno debe estar en true a la vez. Si ENABLE_FALLBACK es true,
// el otro se usa automáticamente como respaldo cuando el primario falla
// con un error reintentable (429, 408, 5xx, red).
// ══════════════════════════════════════════════════════
const ACTIVAR_GEMINI = true;
const ACTIVAR_GROQ   = false;

const ENABLE_FALLBACK = true;

// ══════════════════════════════════════════════════════
// SCHEMA estructurado para Gemini.
// Refuerza el contrato JSON a nivel del modelo, no solo por prompt.
// ══════════════════════════════════════════════════════
const NOMBRES_SCHEMA = {
  type: 'object',
  properties: {
    nombres: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nombre:        { type: 'string' },
          origen:        { type: 'string' },
          significado:   { type: 'string' },
          justificacion: { type: 'string' },
        },
        required: ['nombre', 'origen', 'significado', 'justificacion'],
      },
    },
  },
  required: ['nombres'],
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class ProviderError extends Error {
  constructor(message, { status = 500, provider, retryable } = {}) {
    super(message);
    this.status = status;
    this.provider = provider;
    this.retryable = retryable ?? RETRYABLE_STATUS.has(status);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, temperature, max_tokens, response_format } = req.body;
  const params = { messages, temperature, max_tokens, response_format };

  const chain = buildProviderChain();
  if (chain.length === 0) {
    return res.status(500).json({
      error: 'Ningún proveedor disponible. Configura GEMINI_API_KEY o GROQ_API_KEY y activa el switch en generate.js.',
    });
  }

  let lastError = null;
  for (let i = 0; i < chain.length; i++) {
    const { name, call } = chain[i];
    try {
      const data = await call(params);
      return res.status(200).json({ ...data, _provider: name, _fallback: i > 0 });
    } catch (err) {
      lastError = err;
      // Solo seguimos por la cadena si el error es reintentable.
      if (!err.retryable) break;
    }
  }
  return res.status(lastError?.status || 500).json({
    error:    lastError?.message  || 'Error desconocido',
    provider: lastError?.provider,
  });
}

function buildProviderChain() {
  const all = [
    { name: 'gemini', active: ACTIVAR_GEMINI, key: process.env.GEMINI_API_KEY, call: callGemini },
    { name: 'groq',   active: ACTIVAR_GROQ,   key: process.env.GROQ_API_KEY,   call: callGroq   },
  ];
  const primary  = all.filter(p =>  p.active && p.key);
  if (!ENABLE_FALLBACK) return primary;
  const fallback = all.filter(p => !p.active && p.key);
  return [...primary, ...fallback];
}

// ══════════════════════════════════════════════════════
// GEMINI
// ══════════════════════════════════════════════════════
async function callGemini({ messages, temperature, max_tokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model  = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  if (!apiKey) {
    throw new ProviderError('GEMINI_API_KEY no configurada en el servidor.', {
      provider: 'gemini', retryable: false,
    });
  }

  const systemMsg = messages.find(m => m.role === 'system');
  const userMsg   = messages.find(m => m.role === 'user');

  const body = {
    system_instruction: systemMsg
      ? { parts: [{ text: systemMsg.content }] }
      : undefined,
    contents: [{ role: 'user', parts: [{ text: userMsg?.content || '' }] }],
    generationConfig: {
      temperature:      temperature ?? 1.0,
      maxOutputTokens:  max_tokens  ?? 2000,
      responseMimeType: 'application/json',
      responseSchema:   NOMBRES_SCHEMA,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new ProviderError(`Fallo de red contactando Gemini: ${netErr.message}`, {
      provider: 'gemini', status: 503, retryable: true,
    });
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${r.status}`;
    throw new ProviderError(msg, { provider: 'gemini', status: r.status });
  }

  // Adapta la respuesta de Gemini al formato OpenAI que espera el frontend.
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

// ══════════════════════════════════════════════════════
// GROQ
// ══════════════════════════════════════════════════════
async function callGroq({ messages, temperature, max_tokens, response_format }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model  = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  if (!apiKey) {
    throw new ProviderError('GROQ_API_KEY no configurada en el servidor.', {
      provider: 'groq', retryable: false,
    });
  }

  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens, response_format }),
    });
  } catch (netErr) {
    throw new ProviderError(`Fallo de red contactando Groq: ${netErr.message}`, {
      provider: 'groq', status: 503, retryable: true,
    });
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `Groq HTTP ${r.status}`;
    throw new ProviderError(msg, { provider: 'groq', status: r.status });
  }
  return data;
}
