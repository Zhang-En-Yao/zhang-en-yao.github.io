# AI gateway worker

The Cloudflare Worker behind the ask-the-note assistant. It holds the provider API
keys, so none ever reaches the browser, and normalises Gemini / Mistral / Workers AI
into a single streaming response shape.

This directory is **not** part of the site — GitHub Pages serves the repo root and
simply ignores it. It lives here so the Worker has a history; the deployed copy is
edited in the Cloudflare dashboard.

## Deploying

Paste `index.js` into the Worker's editor and hit Deploy. Nothing else to build: it
is a single file with no imports.

## What the Worker needs

| Setting | Kind | Used by |
| --- | --- | --- |
| `GEMINI_API_KEY` | secret | `/api/gemini` |
| `MISTRAL_API_KEY` | secret | `/api/mistral`, `/api/mistral-large` |
| `AI` | Workers AI binding | every `/api/cloudflare*` route |

## Contract

The browser (`assets/js/chat.js`) posts to `/api/<provider>[-<variant>]`:

```json
{ "system": "…", "messages": [{ "role": "user", "content": "…" }] }
```

and gets back an SSE stream that looks the same for every provider:

```
data: {"text":"…"}
data: [DONE]
```

A failure before the stream opens comes back as JSON `{ "error": "…" }` with a
non-2xx status and CORS headers, so the browser can read the real reason.

## Gotchas worth remembering

- **Model IDs expire.** Gemini 1.5 was retired, and `llama-3.1-8b`, `llama-3.1-70b`
  and `phi-2` all went away on 2026-05-30. When a route starts erroring, check the
  provider's catalogue first — the Worker surfaces the upstream message verbatim.
- **Gemini Pro has no free-tier quota.** `/api/gemini-pro` resolves upstream to a Pro
  model whose free limit is 0, so it always answers with a billing error. The model
  picker deliberately omits it.
- **Workers AI caps output at 256 tokens** unless `max_tokens` says otherwise, which
  truncates a summary mid-sentence. Reasoning tokens count against the same budget,
  and Gemma can spend hundreds of them before it starts answering.
