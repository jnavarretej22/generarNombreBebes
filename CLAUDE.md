# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a static single-page app + one Vercel serverless function. **No build step, no `package.json`, no test suite, no linter.**

- **Local dev:** `vercel dev` (requires Vercel CLI). Serves `index.html` and exposes `/api/generate`.
- **Deploy:** `vercel` (preview) / `vercel --prod`.
- **Required env vars** (set in `.env.local` for local dev, or in the Vercel project for deployed envs):
  - If `ACTIVAR_GEMINI = true` → `GEMINI_API_KEY` (and optional `GEMINI_MODEL`, default `gemini-2.5-flash-lite`).
  - If `ACTIVAR_GROQ = true` → `GROQ_API_KEY` (and optional `GROQ_MODEL`, default `meta-llama/llama-4-scout-17b-16e-instruct`).

## Architecture

### Two-file app
- `index.html` — the entire frontend (HTML + CSS + JS inline). Vanilla JS, no framework, no bundler. Loads Google Fonts only.
- `api/generate.js` — a single Vercel serverless function that proxies AI requests. The frontend never calls a model provider directly; it always POSTs to `/api/generate`.

### Provider switch + automatic fallback (in `api/generate.js`)
Two top-level booleans gate the **primary** provider:

```js
const ACTIVAR_GEMINI = true;
const ACTIVAR_GROQ   = false;
const ENABLE_FALLBACK = true;
```

`buildProviderChain()` puts the primary (active + has key) first; if `ENABLE_FALLBACK` is true, the *other* provider is appended as a fallback when its key is set. The handler walks the chain calling each `call(params)`; if a `ProviderError` has `retryable: true` (HTTP 408/429/500/502/503/504 or network error), it moves to the next provider, otherwise it aborts.

The successful response is augmented with two metadata fields:
- `_provider`: `'gemini'` or `'groq'` — which one actually served the request.
- `_fallback`: `true` if a non-primary provider answered (the frontend logs this to console).

This means **flipping `ACTIVAR_*` no longer requires deploying** if both keys exist — the chain transparently switches under load. Keep the switch flipped to the intended primary, though, for cost/latency control.

`ProviderError` carries `{ status, provider, retryable }`. Use it (not plain `Error`) for anything that touches the provider boundary, otherwise the retryable check defaults to `RETRYABLE_STATUS.has(status)` and may not behave as intended.

### Wire format: OpenAI-shape in, OpenAI-shape out
The frontend speaks the OpenAI chat-completions shape (`messages: [{role, content}], temperature, max_tokens, response_format`). The serverless function:
- For **Groq**, forwards the body as-is to `api.groq.com/openai/v1/chat/completions`.
- For **Gemini**, translates `messages` → `system_instruction` + `contents`, calls `generativelanguage.googleapis.com`, then **adapts the response back to the OpenAI shape** (`{ choices: [{ message: { content } }] }`) so the frontend doesn't care which provider answered.

When adding a new provider, preserve this contract: input/output normalized to the OpenAI shape at the boundary.

### Two distinct generation modes — two distinct system prompts
The UI has tabs ("Describir" / "Combinar nombres") that drive **completely separate system prompts** defined as JS constants:

- `SYSTEM_PROMPT` — free-text mode. Driven by the user's textarea plus optional pills (gender / style / vibe) that compose a Spanish description via `composePrompt()`.
- `SYSTEM_PROMPT_COMBINE` — parent-combination mode. User prompt is built by `buildCombinePrompt(mom, dad, gender, extra)`.

Both prompts enforce the same JSON contract:

```json
{ "nombres": [ { "nombre", "origen", "significado", "justificacion" } ] }
```

The JSON contract is mirrored in **four** places — keep them in sync if you change it: the two system prompts, the parse/validate logic in `callGroq()` inside `index.html` (the function name is historical — it's the generic call to `/api/generate`), and the `NOMBRES_SCHEMA` constant in `api/generate.js` that Gemini uses as `responseSchema` (structured-output enforcement at the model level, not just by prompt).

### Authenticity guardrails (load-bearing, do not soften)
Both system prompts treat **"only real, documented names"** as the primary rule, ranked above sonority/diversity. Explicit prohibitions: no neologisms, no creative spellings of real names, no syllable fusions unless the result happens to coincide with a documented real name. The combine-mode prompt deliberately steers the model toward *finding real names that share sounds/etymology with the parents* rather than inventing fusions like "Marcaros" from "María" + "Carlos".

If you tune these prompts, preserve this hierarchy — past iterations that demoted authenticity produced invented names.

### Repeat-suppression across regenerations
`seenNames` is a `Map<normalized, original>` in `index.html` (normalization = NFD-strip-diacritics + lowercase + remove non-alphanum, see `normalizeName()`). Stored persistently in `localStorage` under `lumen_seen_names` as `{ [promptKey]: [originals[]] }` so exclusions survive page reloads.

On each call to `generate(userPrompt, systemPrompt)`:

1. If `userPrompt !== lastPrompt` → `loadSeenFor(userPrompt)` reloads the map for that prompt key from localStorage.
2. `buildExclusionBlock()` appends a `NOMBRES YA SUGERIDOS: ...` section listing the original-cased names.
3. After the response, `addSeenName()` adds each returned name (dedupe by normalized key, so "Sofía" and "Sofia" collapse to one entry).
4. `persistSeenFor(userPrompt)` writes the updated set back to localStorage.

Both system prompts contain a matching "EXCLUSIÓN OBLIGATORIA" clause. Manual exclusion (✕ button on each card) calls `addSeenName()` + `persistSeenFor()` without regenerating. `clearSeenFor()` resets the map AND removes the prompt's entry from the persisted store — triggered by the "Olvidar descartados" button in the results header.

### "Más como este" (seed-based search)
Each result card has a ✨ button. It calls `buildSimilarPrompt(seed)` to build a description from the seed's `nombre`, `origen` and `significado`, switches the UI to Describir mode, and calls `generate()` with the new prompt. Because the prompt is a new string, it gets its own `seenNames` context — exclusions from the originating search don't carry over.

### Search history
Every successful generation calls `pushHistory(userPrompt, systemPrompt, nombres)`. History is stored under `lumen_history` (capped at 30 entries), deduped by `(prompt, mode)` so regenerations refresh the existing entry instead of stacking duplicates. Each entry stores the full `nombres` array, the mode (`describe`/`combine`), and a timestamp.

The drawer (right side) is **tabbed**: Favoritos / Historial. Each tab has its own footer (compare/copy/clear for favorites; clear-all for history). History items expose three actions:
- **Ver nombres**: load the cached `nombres` into the grid without calling the API. Also re-syncs `seenNames` from `seenStore` and folds in the historical names so the count stays consistent.
- **Volver a buscar**: re-runs the generation with the original prompt + the current accumulated exclusions.
- **Quitar**: remove the entry.

### Name verification (Wikidata + local whitelist)
After each render, `attachVerificationBadges(nombres)` runs **asynchronously** (non-blocking). For each name:

1. **Local whitelist (`KNOWN_NAMES`)** — a `Set` of ~150 well-known names across major cultures, stored normalized. If matched, instant confirmation, no network call.
2. **Per-key cache** in `localStorage` under `lumen_name_verifications` — `{ [normalizedName]: boolean }`, capped at 500 entries (oldest dropped via `Object.keys().slice(-500)`).
3. **Wikidata `wbsearchentities`** — opportunistic CORS call (`origin=*`). Confirmation by description regex match against multilingual name patterns (`NAME_DESC_RE`: "nombre", "given name", "first name", "prénom", "vorname", etc.).

The badge is **positive-only**: when verified, a small "✓ verificado" pill is inserted after the origin badge. Unverified names get nothing — Wikidata coverage isn't universal, and tagging rare-but-real names as "unverified" would be misleading. Verification fails silently on network errors.

`verifyName(name)` is the public entry point; `normalizeName()` (the same one used for `seenNames`) is the cache key. If you change normalization rules, the cache becomes stale — bump the storage key.

### Temperature control
A "Tono" pill bar (Conservador 0.6 / Equilibrado 1.0 / Original 1.3) above the Generar button. `currentTemperature` is read from `localStorage` on init (`lumen_temperature`, default 1.0) and sent in every `/api/generate` request. The backend forwards it to Gemini (`generationConfig.temperature`) and Groq alike.

### Compare favorites modal
"Comparar" button in the favorites footer opens a modal with a 4-column table (Nombre / Origen / Significado / Justificación). "Copiar como texto" exports a bullet-list to clipboard. Closes via the ✕, the footer button, click-outside, or Esc.

### Client-side state (localStorage)
- `lumen_favorites` — array of favorited name objects (full shape: nombre/origen/significado/justificacion).
- `lumen_seen_names` — `{ [promptKey]: [originals[]] }`. Per-prompt exclusion lists. `promptKey` is `normalizeName(prompt).slice(0, 240)`.
- `lumen_history` — array of `{ id, prompt, mode, nombres, timestamp }`, capped at 30, deduped by (prompt, mode).
- `lumen_name_verifications` — `{ [normalizedName]: boolean }` cache of Wikidata lookup results, capped at 500.
- `lumen_temperature` — numeric value (0.6 / 1.0 / 1.3) selected via the tone pills.
- `lumen_theme` — `'dark'` or `'light'`.
- `groq_api_key_baby_names` — historical artifact; the API key is now server-side and the key panel is hidden (`display:none`). Safe to remove if cleaning up.

### Per-culture theming
`cultureKey(origen)` maps free-text origins returned by the model (e.g. "Italiano", "Japonés", "Hebreo") to a fixed set of CSS keys via regex. The CSS uses `[data-culture="..."]` selectors to tint cards and origin badges. If you add a new culture, add both the regex branch and the matching CSS rules.

## Gotchas

- The footer reads "Impulsado por Groq + Llama 4 Scout" but the default switch is Gemini. Cosmetic only — update the footer if you flip the default provider.
- `vercel.json` is empty `{}`. Vercel auto-detects the static + `/api` layout; don't add config unless you have a reason.
- There is no `package.json`, so `vercel dev` runs the function in Vercel's Node runtime without dependencies. The function uses only `fetch` (Node 18+ built-in). Don't introduce `npm` packages without also adding a `package.json` and reviewing the deployment implications.
- `index.html` is ~2200 lines with inline CSS and JS. When editing, prefer `Edit` with enough surrounding context to disambiguate, since many short patterns repeat.
