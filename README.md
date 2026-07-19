# Notes

A static site deployed on GitHub Pages: <https://zhangenyao.github.io>

## Adding a note

1. Create a Markdown file under `notes/`, e.g. `notes/attention-is-all-you-need.md`.
   Start the body at `##` (the title comes from the metadata, so there's no need for an `#`).

2. Add an entry at the top of the array in `notes/index.json`:

   ```json
   {
     "id": "attention-is-all-you-need",
     "title": "Attention Is All You Need",
     "authors": "Ashish Vaswani, et al.",
     "venue": "NeurIPS 2017",
     "year": 2017,
     "tags": ["Neural Networks", "NLP"],
     "summary": "A one-line summary, shown in the list.",
     "url": "https://arxiv.org/abs/1706.03762",
     "file": "attention-is-all-you-need.md"
   }
   ```

   `id` must match the file name, and `file` points at the Markdown file. Notes appear in the list in the same order as this array, so put new ones first. `url`, `venue`, `year`, `tags`, and `summary` are all optional.

3. `git push`, and it goes live a minute or two later.

## Adding flights to a trip

A trip in `travel/index.json` can carry a `flights` array. Each entry is one journey, and
its `legs` are flown in order — a transfer is just the seam between two legs, not a field
of its own. The block renders above the travelogue on `trip.html`.

```json
"flights": [
  {
    "label": "Outbound",
    "legs": [
      {
        "from": { "code": "TPE", "city": "Taipei" },
        "to":   { "code": "HKG", "city": "Hong Kong" },
        "depart": "2019/06/14 21:40",
        "arrive": "2019/06/14 23:35",
        "airline": "Cathay Pacific",
        "number": "CX 407"
      },
      {
        "from": { "code": "HKG", "city": "Hong Kong" },
        "to":   { "code": "KIX", "city": "Osaka" },
        "depart": "2019/06/15 01:55",
        "arrive": "2019/06/15 06:40",
        "airline": "Cathay Pacific",
        "number": "CX 566"
      }
    ]
  }
]
```

**Write every time as the local clock at its own airport** — exactly what the boarding pass
says. Nothing converts them, so a time in any other zone will be wrong on the page. The date
format is the trip's own: `YYYY/MM/DD HH:MM`, and the time may be dropped if you don't have
it.

The page derives the rest. A card is dated by its first departure, and every time under it
that falls on a later day is badged `+1` — so an overnight leg, or a transfer sitting over
midnight, says so. Layovers show their length, because both of those clocks belong to the
same airport; a leg never shows how long it took, because that would need a timezone for
both ends and this file has none.

`label`, `airline`, `number`, and each `city` are optional. Give a place at least a `code`
or a `city`.

## Writing support

- **Markdown**: headings, lists, tables, code blocks, blockquotes. `##` and `###` are picked up automatically by the table of contents on the right.
- **Math**: `$...$` inline, `$$...$$` for display blocks (rendered with KaTeX).
- **Images**: put them in `assets/img/` and reference them as `![caption](../assets/img/xxx.png)`.

## Local preview

Notes are loaded with `fetch`, so opening `index.html` straight from the filesystem gets blocked by the browser's CORS rules. Start a local server instead:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Structure

```
index.html          Note list (search + tag filter)
note.html           Single-note reading page (?id=...)
notes/index.json    Metadata for every note
notes/*.md          Note bodies
assets/css/         Styles (including dark mode)
assets/js/          List, note rendering, theme toggle
```
