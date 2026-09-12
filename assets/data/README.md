# assets/data — what has not moved yet

Everything the site draws now comes from an assets repository over jsDelivr, pinned in
[`assets/js/shared/assets.js`](../js/shared/assets.js) and, per trip, in
[`travel/index.json`](../../travel/index.json):

- the atlas, the marine areas, the continent lookup and the star charts →
  [assets.core](https://github.com/Zhang-En-Yao/assets.core)
- a trip's content, places, streets and photos → `assets.trip.<id>`

What is still here is the tail of trips that have not been migrated. They are read only
when a trip has no `assets` pin, and each file leaves as its trip moves:

| File | Serves |
| --- | --- |
| `places.json` | the Wikidata records for every unmigrated trip |
| `streets/<id>.json` | that trip's OpenStreetMap geometry |

Nothing here is rebuilt in this repository any more — the build scripts live in
[assets.core/build](https://github.com/Zhang-En-Yao/assets.core/tree/main/build), one copy
for every trip. To migrate a trip: create `assets.trip.<id>`, move its `travel/<id>.json`
there as `content.json` and its `streets/<id>.json` as `streets.json`, run the scripts, tag
it, and put the tag in `travel/index.json` as

```json
"assets": "Zhang-En-Yao/assets.trip.<id>@<tag>"
```

replacing that trip's `"file"` key. When this folder is empty, the site is framework only.
