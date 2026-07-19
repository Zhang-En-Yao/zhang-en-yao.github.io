// The ask-this-page assistant. Talks to a Cloudflare Worker gateway that fans out to
// Gemini / Mistral / Workers AI, so no key ever reaches the browser.
//
// This file is the mechanism only — panel, streaming, model picker. What the assistant
// *is* comes from whoever dispatches `chat:init`: note.js makes it a reading assistant
// for a paper, trip.js a companion for a travelogue. Depends on ui.js for `esc` and
// markdown.js for `renderMarkdown`.

const CHAT_ENDPOINT = 'https://large-language-models-proxy.enyaochang.workers.dev';

// The gateway picks the upstream model by sniffing the path, so these routes are
// the model list: /api/<provider>[-<variant>]. The split is where the model runs:
// the first group bills against a provider API key, the second runs on Workers AI
// through the Worker's own AI binding.
// Gemini Pro is deliberately absent: it resolves upstream to a Pro model with no
// free-tier quota, so every call comes back as a billing error.
const MODEL_GROUPS = [
  {
    label: 'Commercial',
    models: [
      { id: 'gemini', label: 'Gemini Flash', vendor: 'Google', path: '/api/gemini' },
      { id: 'mistral', label: 'Mistral Small', vendor: 'Mistral AI', path: '/api/mistral' },
      { id: 'mistral-large', label: 'Mistral Large', vendor: 'Mistral AI', path: '/api/mistral-large' },
    ],
  },
  {
    label: 'Open Source',
    models: [
      { id: 'gemma', label: 'Gemma 4 26B A4B', vendor: 'Google', path: '/api/cloudflare-gemma' },
      { id: 'nemotron', label: 'Nemotron 3 Super 120B', vendor: 'NVIDIA', path: '/api/cloudflare-nemotron' },
      { id: 'granite', label: 'Granite 4.0 H Micro', vendor: 'IBM', path: '/api/cloudflare-granite' },
      { id: 'gpt-oss', label: 'GPT-OSS 120B', vendor: 'OpenAI', path: '/api/cloudflare-gpt-oss' },
      { id: 'mistral-cf', label: 'Mistral Small 3.1 24B', vendor: 'Mistral AI', path: '/api/cloudflare-mistral-small' },
      { id: 'llama', label: 'Llama 3.3 70B', vendor: 'Meta', path: '/api/cloudflare' },
    ],
  },
];

const MODELS = MODEL_GROUPS.flatMap((g) => g.models);

// Shared across pages on purpose: the model you like is a property of you, not of
// whether you are reading a paper or a travelogue. The key predates the trip page,
// hence the name.
const MODEL_KEY = 'note-chat-model';

// The gateway speaks one role vocabulary for every provider; internally a reply is
// a `model` turn, because that is what renderLog keys its bubbles off.
const toGatewayTurns = (history) =>
  history
    .filter((m) => m.text && !m.error)
    .map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }));

// Heavier stroke than the page's icons: these sit on small buttons and read as
// hairlines at 1.5–2.
const svg = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const CHAT_ICONS = {
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  send: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  expand: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
  collapse: svg('<path d="M14 10h6V4"/><path d="M10 14H4v6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
};

const EXPANDED_KEY = 'note-chat-expanded';

const PANEL_HTML = (config) => `
  <div class="chat-header">
    <div>
      <p class="chat-title">${esc(config.title)}</p>
      <p class="chat-subtitle">${esc(config.subtitle)}</p>
    </div>
    <div class="chat-header-actions">
      <button class="icon-btn" data-chat-reset aria-label="Clear conversation">${CHAT_ICONS.reset}</button>
      <button class="icon-btn" data-chat-expand aria-label="Expand panel" aria-pressed="false">${CHAT_ICONS.expand}</button>
      <button class="icon-btn" data-chat-close aria-label="Close assistant">${CHAT_ICONS.close}</button>
    </div>
  </div>
  <div class="chat-log" data-chat-log></div>
  <form class="chat-form" data-chat-form>
    <textarea class="chat-input" data-chat-input rows="1" placeholder="${esc(config.placeholder)}"
      autocomplete="off" enterkeyhint="send"></textarea>
    <div class="chat-form-actions">
      <div class="chat-model" data-chat-model>
        <button class="chat-model-trigger" type="button" data-chat-model-trigger
          aria-haspopup="listbox" aria-expanded="false" aria-label="Model">
          <span data-chat-model-label></span>
          <span class="chat-model-badge" data-chat-model-vendor></span>
          ${CHAT_ICONS.chevron}
        </button>
        <div class="chat-model-menu" data-chat-model-menu role="listbox" aria-label="Model" hidden>
          ${MODEL_GROUPS.map((g) => `
            <p class="chat-model-group">${g.label}</p>
            ${g.models.map((m) => `
              <button class="chat-model-option" type="button" role="option" aria-selected="false" data-model-id="${m.id}">
                <span class="chat-model-name">${m.label}</span>
                <span class="chat-model-vendor">${m.vendor}</span>
              </button>`).join('')}`).join('')}
        </div>
      </div>
      <button class="chat-send" type="submit" data-chat-send aria-label="Send">${CHAT_ICONS.send}</button>
    </div>
  </form>`;

// config: { title, subtitle, placeholder, intro, system, suggestions }
// `system` is the whole personality — the page builds it, this file just sends it.
function initChat(config) {
  const root = document.createElement('div');
  root.className = 'chat';
  root.innerHTML = `
    <button class="chat-fab" data-chat-open aria-label="${esc(config.title)}" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 0 1 0 18 9.6 9.6 0 0 1-4-.8L3 21l1.3-4.2A9 9 0 0 1 12 3Z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5"/><path d="M12 16.5h.01"/></svg>
    </button>
    <section class="chat-panel" data-chat-panel hidden>${PANEL_HTML(config)}</section>`;
  document.body.appendChild(root);

  const panel = root.querySelector('[data-chat-panel]');
  const logEl = root.querySelector('[data-chat-log]');
  const formEl = root.querySelector('[data-chat-form]');
  const inputEl = root.querySelector('[data-chat-input]');
  const sendEl = root.querySelector('[data-chat-send]');
  const openEl = root.querySelector('[data-chat-open]');
  const expandEl = root.querySelector('[data-chat-expand]');
  const modelTriggerEl = root.querySelector('[data-chat-model-trigger]');
  const modelMenuEl = root.querySelector('[data-chat-model-menu]');
  const modelLabelEl = root.querySelector('[data-chat-model-label]');
  const modelVendorEl = root.querySelector('[data-chat-model-vendor]');
  const modelOptionEls = [...root.querySelectorAll('[data-model-id]')];

  const history = [];
  let streaming = null;
  let model = MODELS[0];

  function scrollDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  const isExpanded = () => panel.classList.contains('is-expanded');

  // Each suggestion comes in two strengths. The collapsed panel is a narrow column with
  // room for one line, so it offers `short` — the question as you would actually type it.
  // Expanded, there is room to both name the ask and spell it out, so the chip grows a
  // second line and sends `detailed` instead: same intent, but with the shape of the
  // answer specified, which is what a bigger panel is for.
  function renderSuggestion(s) {
    if (!isExpanded()) {
      return `<button class="chat-chip" data-chat-suggest="${esc(s.short)}">${esc(s.short)}</button>`;
    }
    return `
      <button class="chat-chip chat-chip-rich" data-chat-suggest="${esc(s.detailed)}">
        <span class="chat-chip-label">${esc(s.label)}</span>
        <span class="chat-chip-detail">${esc(s.detailed)}</span>
      </button>`;
  }

  function renderLog() {
    if (!history.length) {
      logEl.innerHTML = `
        <div class="chat-intro">
          <p>${esc(config.intro)}</p>
          <div class="chat-suggestions">
            ${config.suggestions.map(renderSuggestion).join('')}
          </div>
        </div>`;
      return;
    }

    logEl.innerHTML = history
      .map((m) => {
        const body = m.role === 'user'
          ? `<p>${esc(m.text)}</p>`
          : renderMarkdown(m.text || '', { breaks: true });
        const pending = m.role === 'model' && !m.text ? '<span class="chat-dots"><i></i><i></i><i></i></span>' : '';
        const error = m.error ? ` chat-msg-error` : '';
        return `<div class="chat-msg chat-msg-${m.role}${error}">${pending || body}</div>`;
      })
      .join('');
    scrollDown();
  }

  // While streaming, this same button becomes the stop control — so it must stay clickable.
  function setBusy(busy) {
    sendEl.innerHTML = busy ? CHAT_ICONS.stop : CHAT_ICONS.send;
    sendEl.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendEl.classList.toggle('is-busy', busy);
  }

  async function ask(question) {
    if (streaming) return;

    const priorTurns = history.slice();

    history.push({ role: 'user', text: question });
    const reply = { role: 'model', text: '' };
    history.push(reply);
    renderLog();
    setBusy(true);

    const controller = new AbortController();
    streaming = controller;

    try {
      const res = await fetch(`${CHAT_ENDPOINT}${model.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          system: config.system,
          messages: [...toGatewayTurns(priorTurns), { role: 'user', content: question }],
        }),
      });

      // A failure lands as JSON before the stream opens.
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // The gateway normalises every provider to `data: {"text":"…"}` frames
      // separated by a blank line. Those breaks can arrive as CRLF.
      const consume = (frame) => {
        const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (!line) return;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;

        try {
          reply.text += JSON.parse(payload).text || '';
        } catch (e) {
          // ignore a malformed frame
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();

        frames.forEach(consume);
        renderLog();
      }

      consume(buffer);
      renderLog();

      if (!reply.text) {
        reply.text = 'No response came back. Please try again.';
        reply.error = true;
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!reply.text) history.splice(history.indexOf(reply), 1);
      } else {
        reply.text = `Something went wrong: ${err.message}`;
        reply.error = true;
      }
    } finally {
      streaming = null;
      setBusy(false);
      renderLog();
      inputEl.focus();
    }
  }

  function submit() {
    const question = inputEl.value.trim();
    if (!question || streaming) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    ask(question);
  }

  function toggle(open) {
    panel.hidden = !open;
    openEl.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!logEl.innerHTML) renderLog();
      inputEl.focus();
      scrollDown();
    }
  }

  function setExpanded(on) {
    panel.classList.toggle('is-expanded', on);
    expandEl.innerHTML = on ? CHAT_ICONS.collapse : CHAT_ICONS.expand;
    expandEl.setAttribute('aria-label', on ? 'Shrink panel' : 'Expand panel');
    expandEl.setAttribute('aria-pressed', String(on));

    // The suggestions are the one thing in the log that depends on the panel's size,
    // and they only exist before the first question.
    if (!history.length && logEl.innerHTML) renderLog();
    try {
      localStorage.setItem(EXPANDED_KEY, on ? '1' : '0');
    } catch (e) {
      // private mode: the size just won't persist
    }
  }

  // The model picker is a custom listbox rather than a <select>, because an option has
  // to carry a second line (the vendor) and the trigger a badge — neither of which a
  // native select can render.
  function setModel(id, persist) {
    model = MODELS.find((m) => m.id === id) || model;
    modelLabelEl.textContent = model.label;
    modelVendorEl.textContent = model.vendor;
    modelOptionEls.forEach((el) => {
      el.setAttribute('aria-selected', String(el.dataset.modelId === model.id));
    });
    if (!persist) return;
    try {
      localStorage.setItem(MODEL_KEY, model.id);
    } catch (e) {
      // private mode: the choice just won't persist
    }
  }

  function toggleModelMenu(open) {
    modelMenuEl.hidden = !open;
    modelTriggerEl.setAttribute('aria-expanded', String(open));
  }

  expandEl.addEventListener('click', () => {
    setExpanded(!panel.classList.contains('is-expanded'));
    scrollDown();
  });

  openEl.addEventListener('click', () => toggle(panel.hidden));
  root.querySelector('[data-chat-close]').addEventListener('click', () => toggle(false));

  root.querySelector('[data-chat-reset]').addEventListener('click', () => {
    streaming?.abort();
    history.length = 0;
    renderLog();
    inputEl.focus();
  });

  logEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chat-suggest]');
    if (chip) ask(chip.dataset.chatSuggest);
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (streaming) streaming.abort();
    else submit();
  });

  // A CJK IME confirms its candidate with Enter. Chrome flags that keydown with
  // isComposing, but Safari clears the flag and fires compositionend first, so the
  // confirming Enter looks like a plain one. Track composition ourselves, honour the
  // legacy 229 keycode, and ignore an Enter that lands in the same tick as the end of
  // a composition — a human sending a message is always slower than that.
  let composing = false;
  let compositionEndedAt = -Infinity;

  inputEl.addEventListener('compositionstart', () => {
    composing = true;
  });

  inputEl.addEventListener('compositionend', (e) => {
    composing = false;
    compositionEndedAt = e.timeStamp;
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.timeStamp - compositionEndedAt < 50) return;
    e.preventDefault();
    submit();
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
  });

  // Escape peels off one layer at a time: the open menu first, then the panel.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modelMenuEl.hidden) toggleModelMenu(false);
    else if (!panel.hidden) toggle(false);
  });

  modelTriggerEl.addEventListener('click', () => toggleModelMenu(modelMenuEl.hidden));

  modelMenuEl.addEventListener('click', (e) => {
    const option = e.target.closest('[data-model-id]');
    if (!option) return;
    setModel(option.dataset.modelId, true);
    toggleModelMenu(false);
    inputEl.focus();
  });

  // A click anywhere else dismisses the menu, the way a native select would.
  document.addEventListener('click', (e) => {
    if (!modelMenuEl.hidden && !e.target.closest('[data-chat-model]')) toggleModelMenu(false);
  });

  let storedExpanded = null;
  let storedModel = null;
  try {
    storedExpanded = localStorage.getItem(EXPANDED_KEY);
    storedModel = localStorage.getItem(MODEL_KEY);
  } catch (e) {
    // ignore
  }
  setExpanded(storedExpanded === '1');
  setModel(storedModel, false);

  renderLog();
}

// The page decides what the assistant knows and how it introduces itself, and says so
// once its content is on screen. Whichever page loads this file, exactly one fires.
document.addEventListener('chat:init', (e) => initChat(e.detail), { once: true });
