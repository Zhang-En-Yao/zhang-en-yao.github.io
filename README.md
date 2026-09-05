# zhangenyao.github.io

A static site on GitHub Pages: <https://zhangenyao.github.io>

- **Travels** — a world map of every trip, and a travelogue for each one.
- **Bucket List** — festivals worth crossing a border for.

No build step. Every page is plain HTML that loads its own CSS and JS from `assets/`.

## Adding a trip

1. Create a Markdown travelogue under `travel/`, e.g. `travel/202610222105.md`. Start the
   body at `#`/`##` — the title is built from the cities in the index.

2. Add an entry to the top of `travel/index.json` (newest first):

   ```json
   {
     "id": "202610222105",
     "country": "Spain",
     "continent": "Europe",
     "cities": [
       { "name": "Madrid", "lat": 40.4168, "lon": -3.7038 }
     ],
     "file": "202610222105.md"
   }
   ```

   `id` leads with a zero-padded date so trips sort chronologically on their own. `country`
   must match a name in `assets/data/countries-50m.json` for the map tint. `file` is
   optional — an entry without one is a dot on the map with no travelogue behind it.

3. `git push`; it is live a minute or two later.

Optional keys: `flights` (see below), `areas` (a small labelled map under a named section
heading — the `heading` must match a heading in the Markdown), `newYear` / `pilgrimage`
(card tags).

`photos` / `photoRepo` (a "Gallery" section at the foot of the travelogue, stacked full-width
and served from a per-trip photo repo through jsDelivr) go on the trip's own content JSON;
they are still read from the `index.json` entry as a fallback for a Markdown trip.

## Adding flights to a trip

A trip in `travel/index.json` can carry a `flights` array. Each entry is one journey, and
its `legs` are flown in order — a transfer is just the seam between two legs, not a field
of its own. The block renders above the travelogue on `trip.html`.

```json
"flights": [
  {
    "legs": [
      {
        "from": { "code": "TPE", "city": "Taipei" },
        "to":   { "code": "HKG", "city": "Hong Kong" },
        "depart": "2019/06/14 21:40",
        "arrive": "2019/06/14 23:35",
        "airline": "Cathay Pacific",
        "number": "CX 407"
      }
    ]
  }
]
```

**Write every time as the local clock at its own airport** — exactly what the boarding pass
says. Nothing converts them. The date format is `YYYY/MM/DD HH:MM`, and the time may be
dropped. A card is dated by its first departure, and every time under it that falls on a
later day is badged `+1`. `airline`, `number`, and each `city` are optional; give a place at
least a `code` or a `city`.

## Adding a bucket-list entry

Add to `bucket-list/index.json`: `id`, `name`, `country`, `category` (`religion` /
`newyear` / `festival`), `month`, optional `day`, `when` (a human phrase), `note`, `cities`,
and `done: true` once it has happened.

## Writing support

- **Markdown**: headings, lists, tables, links, code blocks, blockquotes. `##` and `###`
  feed the table of contents on the right of a travelogue.
- **Photos in the body**: a paragraph of only images becomes a column of captioned figures;
  wrap the run in `<div class="photo-strip"> … </div>` (blank lines around the images) to
  make it a horizontal filmstrip instead.
- **Selection translation**: selecting a passage in a travelogue puts a **Translate** pill
  at its end; clicking sends just that selection to a Cloudflare Worker LLM gateway
  (GPT-OSS 120B) and streams the translation into a sheet (right on desktop, bottom on
  mobile). One paragraph at a time, target language remembered (`assets/js/translate.js`).

## Local preview

Pages load their data with `fetch`, so opening a file straight from disk is blocked by CORS.
Serve the folder instead:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Structure

```
index.html           The hub
travel.html          World map + list of trips
trip.html            One travelogue (?id=…) — maps, flights, photos, selection translation
bucket-list.html     Festivals, grouped by reason to go
travel/*.md          Travelogue bodies
travel/index.json    Trip metadata
bucket-list/index.json
assets/css/           core · home · cards · travel · bucket · trip · translate
assets/js/            per-page scripts, plus shared ui.js / markdown.js / thumb.js
assets/data/          world atlas (TopoJSON) and the scripts that build it
```
