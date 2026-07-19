// Cloudflare Worker: AI gateway for the ask-the-note assistant.
//
// Deployed separately from this site. Paste it into the Worker, or `wrangler deploy` it.
//
// Request   POST /api/<provider>[-<variant>]
//           { system?: string, messages: [{ role: "user" | "assistant", content: string }] }
//
// Response  text/event-stream, one shape for every provider:
//             data: {"text":"…"}   incremental token(s)
//             data: [DONE]         end of stream
//           Failures before the stream opens come back as JSON { error } with a
//           non-2xx status — always with CORS headers, so the browser can read them.
//
// Providers stream in several different shapes (Gemini: candidates[].content.parts[],
// Mistral and the newer Workers AI models: choices[].delta.content, older Workers AI
// models: response). Normalising here means the browser only ever parses one of them.

const GEMINI_API_HOST = "generativelanguage.googleapis.com";
const MISTRAL_API_HOST = "api.mistral.ai";

// Workers AI routes: /api/cloudflare[-<slug>]. IDs get retired on a schedule —
// llama-3.1-8b, llama-3.1-70b and phi-2 all went away on 2026-05-30 — so check the
// catalogue when one of these starts erroring.
//
// `context` is the model's whole window, which the prompt and the reply share; none
// of these models publishes a separate output ceiling. Note how far apart they are —
// Llama has a tenth of Gemma's room.
const CF_MODELS = {
  "": { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", context: 24_000 },
  "gpt-oss": { id: "@cf/openai/gpt-oss-120b", context: 128_000 },
  gemma: { id: "@cf/google/gemma-4-26b-a4b-it", context: 256_000 },
  nemotron: { id: "@cf/nvidia/nemotron-3-120b-a12b", context: 256_000 },
  granite: { id: "@cf/ibm-granite/granite-4.0-h-micro", context: 131_000 },
  "mistral-small": { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", context: 128_000 },
};

// Workers AI stops at 256 tokens unless told otherwise, which cuts a note summary off
// mid-sentence, so every request has to name its own ceiling. max_tokens is a ceiling
// and not a target — the model still emits its stop token when it is done — so the only
// job here is to pick a number that is comfortably large and that the model will accept.
//
// It used to be "everything the prompt did not use", which asked for ~128k and made the
// whole thing hostage to the estimate below: guess the prompt too small and the request
// asks for more room than the context holds, which Workers AI rejects outright with
// `3030: Internal Server Error` rather than clamping. granite had only 72 tokens of
// slack between its configured context and its real one, so it was the first to go.
// Nothing this gateway serves wants a 128k reply, so a flat ceiling buys the same uncut
// answers and makes the estimate's accuracy stop mattering: 8192 is far below every
// model's limit, whatever the prompt turns out to weigh.
const CF_TOKEN_RESERVE = 1024;
const CF_MIN_TOKENS = 256;
const CF_MAX_TOKENS = 8192;

// Three chars per token suits the Latin text this gateway sees. It badly underestimates
// CJK — which runs nearer one token per character — but that only matters if a prompt
// ever came within CF_MAX_TOKENS of the context, and none does: the ceiling above is
// what keeps a wrong guess harmless.
const estimateTokens = (text) => Math.ceil((text || "").length / 3);

function outputBudget(model, system, messages) {
  const prompt =
    estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  const room = model.context - prompt - CF_TOKEN_RESERVE;
  return Math.max(CF_MIN_TOKENS, Math.min(CF_MAX_TOKENS, room));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const sse = (stream) =>
  new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    },
  });

// Upstreams report failures as JSON, but not all with the same key.
async function upstreamError(res) {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.message || body;
  } catch (e) {
    return body || `HTTP ${res.status}`;
  }
}

const encoder = new TextEncoder();
// Both must mint a fresh array per call: the runtime detaches a buffer once it is
// enqueued, so a shared constant would arrive empty on every later request that
// the same isolate handles.
const done = () => encoder.encode("data: [DONE]\n\n");
const chunk = (text) => encoder.encode(`data: ${JSON.stringify({ text })}\n\n`);

// Re-emits an upstream SSE body as our own `{ text }` frames. `pick` pulls the
// delta out of one upstream payload; whatever it returns empty for is dropped
// (Gemini interleaves thought parts, Mistral sends a final empty delta).
function relay(upstream, pick) {
  const decoder = new TextDecoder();
  let buffer = "";

  return upstream.pipeThrough(
    new TransformStream({
      transform(value, controller) {
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line, and the last piece is usually a
        // partial frame — it has to wait for the next chunk.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();

        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
          if (!line) continue;

          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            // Workers AI hands back a bare number for a token like "2", so the
            // pick has to be stringified before it goes out — otherwise the frame
            // breaks the `{ text: string }` contract. Once it is a string, the
            // empty check is safe: only "" is falsy, and "0" survives.
            const text = String(pick(JSON.parse(payload)) ?? "");
            if (text) controller.enqueue(chunk(text));
          } catch (e) {
            // A malformed frame is not worth killing the stream over.
          }
        }
      },
      flush(controller) {
        controller.enqueue(done());
      },
    }),
  );
}

// Mistral and Workers AI both take OpenAI-style messages with a system role.
const withSystem = (system, messages) =>
  system ? [{ role: "system", content: system }, ...messages] : messages;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;
    if (path === "/" || path === "") return json({ status: "AI gateway is running" });

    try {
      const { system = "", messages = [] } = await request.json();
      if (!messages.length) return json({ error: "`messages` is required" }, 400);

      // ---------- Google Gemini ----------
      if (path.startsWith("/api/gemini")) {
        if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY is not set" }, 500);

        // The 1.5 models are retired; the -latest aliases track the current release.
        const model = path.includes("pro") ? "gemini-pro-latest" : "gemini-flash-latest";

        const url = new URL(
          `https://${GEMINI_API_HOST}/v1beta/models/${model}:streamGenerateContent`,
        );
        url.searchParams.set("alt", "sse");
        url.searchParams.set("key", env.GEMINI_API_KEY);

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Gemini keeps the system prompt out of the turns, and calls the
            // assistant "model".
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: messages.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
          }),
        });

        if (!res.ok) return json({ error: await upstreamError(res) }, 502);

        return sse(
          relay(res.body, (c) =>
            (c.candidates?.[0]?.content?.parts || [])
              .filter((p) => typeof p.text === "string" && !p.thought)
              .map((p) => p.text)
              .join(""),
          ),
        );
      }

      // ---------- Mistral ----------
      if (path.startsWith("/api/mistral")) {
        if (!env.MISTRAL_API_KEY) return json({ error: "MISTRAL_API_KEY is not set" }, 500);

        let model = "mistral-small-latest";
        if (path.includes("large")) model = "mistral-large-latest";
        if (path.includes("coder")) model = "codestral-latest";

        const res = await fetch(`https://${MISTRAL_API_HOST}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
          },
          body: JSON.stringify({ model, stream: true, messages: withSystem(system, messages) }),
        });

        if (!res.ok) return json({ error: await upstreamError(res) }, 502);

        return sse(relay(res.body, (c) => c.choices?.[0]?.delta?.content ?? ""));
      }

      // ---------- Cloudflare Workers AI ----------
      if (path.startsWith("/api/cloudflare")) {
        if (!env.AI) return json({ error: "The AI binding is missing on this Worker" }, 500);

        const slug = path.slice("/api/cloudflare".length).replace(/^-/, "");
        const model = CF_MODELS[slug];
        if (!model) {
          return json({ error: `Unknown Workers AI model: ${slug || "(default)"}` }, 404);
        }

        const maxTokens = outputBudget(model, system, messages);

        // With stream: true this resolves to a ReadableStream of SSE frames.
        // Gemma has deprecated max_tokens in favour of max_completion_tokens, and the
        // others do not know the newer name, so both go out and each model reads the
        // one it understands.
        const upstream = await env.AI.run(model.id, {
          stream: true,
          max_tokens: maxTokens,
          max_completion_tokens: maxTokens,
          messages: withSystem(system, messages),
        });

        // Workers AI streams in two shapes. The older models (Llama) send a bare
        // `{ response }`; the newer ones (GPT-OSS, Gemma, Mistral 3.1) send OpenAI
        // chat.completion.chunk. Reading only `delta.content` also drops the
        // reasoning tokens those models interleave — Gemma emits hundreds of them
        // for a one-line answer, and none belong in the reply.
        return sse(
          relay(upstream, (c) => c.response ?? c.choices?.[0]?.delta?.content ?? ""),
        );
      }

      return json({ error: `Unsupported endpoint: ${path}` }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
