# zhang-en-yao.github.io

A static site on GitHub Pages: <https://zhang-en-yao.github.io>

- **Travels** — a world map of every trip, and a travelogue for each one.
- **Bucket List** — festivals worth crossing a border for.

No build step: plain HTML, CSS, and native ES modules.

## Adding a trip

1. Add an entry to `travel/index.json`:

   ```json
   {
     "id": "202610222105",
     "country": "Spain",
     "continent": "Europe",
     "cities": [{ "name": "Madrid", "lat": 40.4168, "lon": -3.7038 }],
     "file": "202610222105.json"
   }
   ```

   - `id` starts with a zero-padded `YYYYMMDDhhmm` timestamp, so trips sort by date.
   - `country` must match a name in `assets/data/countries-50m.json` (the console warns if not).
   - `file` is optional; without it the trip is a dot on the map with no travelogue.
   - Optional: `flights` (below), `duration` (`"2025/12/28-2026/01/03"`, otherwise taken
     from the flights), `newYear` / `pilgrimage` (card tags).

2. Write the travelogue as `travel/<id>.json`:

   ```json
   {
     "photos": ["DSCF0217.jpg", { "file": "DSCF0239.jpg", "alt": "Dotonbori" }],
     "sections": [
       {
         "heading": "Madrid",
         "intro": ["Paragraph with *inline Markdown*."],
         "lodging": "Hotel name",
         "route": false,
         "subsections": [
           {
             "heading": "Mayrit to Madrid of the Golden Age",
             "intro": ["…"],
             "points": [
               { "name": "Puerta del Sol", "kind": "Plaza", "lat": 40.41694, "lon": -3.70361, "body": ["…"] }
             ]
           }
         ]
       }
     ]
   }
   ```

   Each subsection gets a map of its points, split into several maps when points are more
   than 3.5 km apart. A section with `"route": true` instead gets one map joining every stop
   in order. `photos` become a Gallery at the end; they load from `photoRepo`
   (`owner/repo[@branch]`, default `ZhangEnYao/<id>`) through jsDelivr, or from a full URL.

3. Fetch street geometry for the new maps (optional, but maps are bare without it):

   ```sh
   python3 assets/data/build-streets.py --trip 202610222105
   ```

4. `git push`; it is live a minute or two later.

## Flights

A trip's `flights` is a list of journeys, each a list of `legs` flown in order:

```json
"flights": [
  {
    "legs": [
      {
        "from": { "code": "TPE", "city": "Taipei" },
        "to": { "code": "HKG", "city": "Hong Kong" },
        "depart": "2019/06/14 21:40",
        "arrive": "2019/06/14 23:35",
        "airline": "Cathay Pacific",
        "number": "CX 407"
      }
    ]
  }
]
```

Write every time as the local time at its own airport, exactly as the boarding pass shows
(`YYYY/MM/DD HH:MM`, time optional). `airline`, `number`, and `city` are optional.

## Adding a bucket-list entry

Add to `bucket-list/index.json`: `id`, `name`, `country`, `category` (`religion` / `newyear` /
`festival`), `month`, optional `day`, `when` (display text), `note`, `cities`, and
`done: true` once it has happened. Entries in a country with a trip get a "Been" tag.

## Local preview

Pages fetch their data and use ES modules, so serve the folder instead of opening files:

```sh
python3 -m http.server 8000
```

### Previewing a trip repo before it's published

A migrated trip's `assets` pin (`owner/repo@tag` in `travel/index.json`) only resolves once
that repo has been pushed and tagged — there's no way to point it at a local, unpublished
checkout. To read a trip repo's `content.json` (plus `streets.json` / `places.json` if
already built) before it's tagged, use the local-file fallback `render()` still supports for
an unmigrated trip:

```sh
ln -s /path/to/assets.trip.<id>/content.json travel/<id>.json
ln -s /path/to/assets.trip.<id>/streets.json assets/data/streets/<id>.json
```

Then add `"file": "<id>.json"` to that trip's entry in `travel/index.json` and open
`trip.html?id=<id>` on the local server above. `places.json` has no local-fallback path
(`assets/data/places.json` is the old shared aggregate, now unused) — skip it; the page
reads fine without it, just without fact cards.

Both the symlinks and the `file` key are local-only scaffolding: once the trip repo is
tagged, remove them and set `assets` instead (`git checkout travel/index.json` plus `rm` the
symlinks undoes this cleanly).

## Structure

```
index.html  travel.html  trip.html  bucket-list.html
travel/index.json            trip metadata
travel/<id>.json             travelogue content
assets/data/streets/<id>.json cached street geometry (build-streets.py)
bucket-list/index.json
assets/css/                  core · home · cards · travel · bucket · trip · translate
assets/js/theme.js           classic script in <head>, sets the theme before first paint
assets/js/{travel,trip,bucket-list}.js   page entry modules
assets/js/shared/            dom helpers, date formatting, atlas loading, country thumbnails
assets/js/travel/            world map
assets/js/trip/              content, maps, clusters, flights, gallery, lightbox, ambient,
                             table of contents, jump-back pill, selection translation
assets/data/                 world atlas, continent lookup, and the scripts that build them
```

d3-geo, topojson-client, and marked load from jsDelivr as globals before the modules run.
