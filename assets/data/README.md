# assets/data — what has not moved yet

Everything the site draws now comes from an assets repository over jsDelivr, pinned in
[`assets/js/shared/assets.js`](../js/shared/assets.js) and, per trip, in
[`travel/index.json`](../../travel/index.json):

- the atlas, the marine areas, the continent lookup and the star charts →
  [assets.core](https://github.com/Zhang-En-Yao/assets.core)
- a trip's content, places, streets and photos → `assets.trip.<id>`

One trip has not moved yet — Spain, `202610222105` — and these are the two files it still
reads. They go with it:

| File | Serves |
| --- | --- |
| `places.json` | the Wikidata records for every unpinned trip |
| `streets/<id>.json` | that trip's OpenStreetMap geometry |

Photos cannot stay here: `trip/gallery.js` builds photo URLs only from a trip's `assets`
pin, so an unpinned trip with photos has nowhere to fetch them from. `tools/check-assets.py`
fails the build rather than letting the gallery come up empty.

Nothing here is rebuilt in this repository any more — the build scripts live in
[assets.core/build](https://github.com/Zhang-En-Yao/assets.core/tree/main/build), one copy
for every trip. To migrate a trip: create `assets.trip.<id>`, move its `travel/<id>.json`
there as `content.json` and its `streets/<id>.json` as `streets.json`, run the scripts, tag
it, and put the tag in `travel/index.json` as

```json
"assets": "Zhang-En-Yao/assets.trip.<id>@<tag>"
```

replacing that trip's `"file"` key. When this folder is empty, the site is framework only.
