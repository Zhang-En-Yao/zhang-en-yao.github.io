export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function fetchJson(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${src}: ${res.status}`);
  return res.json();
}

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  spinner: '<span class="spinner" aria-hidden="true"></span>',
  search: svg('<path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 17h.01"/><path d="M9.1 12a2.5 2.5 0 1 1 3.5 2.3c-.4.2-.6.6-.6 1"/>'),
  alert: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
};

// `title`, `description` and `actions` are HTML: escape data before passing it in.
export function emptyState({ icon = 'search', title, description = '', actions = '' }) {
  return `
    <div class="empty">
      <div class="empty-header">
        <div class="empty-media">${ICONS[icon] || ''}</div>
        <p class="empty-title">${title}</p>
        ${description ? `<p class="empty-description">${description}</p>` : ''}
      </div>
      ${actions ? `<div class="empty-content">${actions}</div>` : ''}
    </div>`;
}

export const SERVE_HINT =
  'If you opened this file directly, serve the folder with <code>python3 -m http.server</code> instead.';

export const RETRY_BUTTON = '<button type="button" class="btn" onclick="location.reload()">Retry</button>';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
