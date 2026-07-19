// The note page: renders one paper note, and hands chat.js a reading assistant for it.
// Depends on ui.js (`esc`, `emptyState`) and markdown.js (`renderMarkdown`, `decorateBody`).

const noteEl = document.getElementById('note');
const tocEl = document.getElementById('toc');
const id = new URLSearchParams(location.search).get('id');

const SUGGESTIONS = [
  {
    label: 'Summarize',
    short: 'Summarize this note.',
    detailed:
      'Summarize this note: the problem it takes on, the claim it makes, the evidence that claim rests on, and what it leaves unresolved.',
  },
  {
    label: 'Central argument',
    short: 'What is the central argument?',
    detailed:
      'State the central argument in one sentence, then lay out the steps it moves through and name the assumption each step needs.',
  },
  {
    label: 'Structure',
    short: 'Illustrate the structure with a diagram.',
    detailed:
      'Draw the structure of this note as a mermaid diagram, then say in one line each what the nodes and the edges stand for.',
  },
];

function systemPrompt(meta, markdown) {
  return `You are a rigorous reading assistant helping a reader understand a paper note.

Title: ${meta.title}
${meta.authors ? `Authors: ${meta.authors}` : ''}
${meta.year ? `Year: ${meta.year}` : ''}

Here is the full note (Markdown, with mathematics in LaTeX):

<note>
${markdown}
</note>

Rules:
- Answer from the note above. If the note does not cover something, say so plainly, then add outside knowledge only if it helps — and label it as going beyond the note.
- Reply in the language the reader writes in; default to English.
- Be concise and get to the point. Quote the note directly when it helps.
- Write mathematics as LaTeX, using $…$ or $$…$$.`;
}

function headerHtml(meta) {
  return `
    <div class="note-header">
      <a href="${esc(meta.url)}" target="_blank" rel="noopener">${esc(meta.title)}</a>
      ${meta.authors ? `<p class="authors">${esc(meta.authors)}</p>` : ''}
      ${meta.venue ? `<p class="venue">${esc(meta.venue)}</p>` : ''}
      ${meta.year ? `<p class="publish-date">${esc(meta.year)}</p>` : ''}
      <div class="tags">${(meta.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>`;
}

if (!id) {
  noteEl.innerHTML = emptyState({
    icon: 'file',
    title: 'No note specified',
    description: 'This page needs an <code>?id=</code> parameter to know which note to open.',
    actions: '<a class="btn" href="notes.html">Back to the list</a>',
  });
} else {
  fetch('notes/index.json')
    .then((r) => r.json())
    .then((notes) => {
      const meta = notes.find((n) => n.id === id);
      if (!meta) throw new Error('not found');

      document.title = `${meta.title} — Notes`;

      return fetch(`notes/${meta.file}`)
        .then((r) => {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        })
        .then((md) => {
          noteEl.innerHTML = `${headerHtml(meta)}<div class="note-body">${renderMarkdown(md)}</div>`;
          decorateBody(noteEl.querySelector('.note-body'), tocEl);

          document.dispatchEvent(new CustomEvent('chat:init', {
            detail: {
              title: 'Ask this note',
              subtitle: 'Model · grounded in this note',
              placeholder: 'Ask about this note…',
              intro: 'Ask me anything about this note.',
              system: systemPrompt(meta, md),
              suggestions: SUGGESTIONS,
            },
          }));
        });
    })
    .catch(() => {
      noteEl.innerHTML = emptyState({
        icon: 'search',
        title: 'Note not found',
        description: `No note matches <code>${esc(id)}</code>, or its file could not be fetched. ${SERVE_HINT}`,
        actions: '<a class="btn" href="notes.html">Back to the list</a>',
      });
    });
}
