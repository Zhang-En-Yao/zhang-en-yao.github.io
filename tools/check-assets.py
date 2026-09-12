#!/usr/bin/env python3
"""Fetch everything this site pins, and check it is what the site's modules expect.

The site holds no data. It holds URLs — one pin for assets.core in
assets/js/shared/assets.js, and one `assets` pin per trip in travel/index.json — and every
one of them points into a different repository that can be rebuilt without this one
knowing. That is the whole point of the split, and it is also the one thing that can break
silently: a pin that 404s, or a rebuild that renamed a field, shows up as an empty map or a
missing fact panel, not as an error.

So this asks the CDN for every pinned file and checks the *keys the code actually reads*.
Not a schema — a schema drifts away from the code. The lists below are copied from the
modules named beside them, and the point of failure is here, in CI, rather than in someone's
browser.

    python3 tools/check-assets.py            # every pin
    python3 tools/check-assets.py --core     # just assets.core

Exit code 1 on any failure.
"""

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS_JS = ROOT / "assets" / "js" / "shared" / "assets.js"
INDEX = ROOT / "travel" / "index.json"
TIMEOUT = 60

problems = []


def fail(where, message):
    problems.append(f"{where}: {message}")


def get(url):
    """The pinned file, or None with the failure recorded."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        fail(url, f"HTTP {e.code} — the tag does not exist, or the file is not in it")
    except (urllib.error.URLError, TimeoutError) as e:
        fail(url, f"unreachable ({e})")
    except json.JSONDecodeError as e:
        fail(url, f"not valid JSON ({e}) — jsDelivr may be serving an error page")
    return None


def core_pin():
    """The tag in assets.js, read as text: the site has no build step, so there is nothing
    to import it from."""
    match = re.search(r"export const CORE = `([^`]+)`", ASSETS_JS.read_text())
    if not match:
        raise SystemExit(f"no CORE pin in {ASSETS_JS.relative_to(ROOT)}")
    url = match.group(1).replace("${CDN}", "https://cdn.jsdelivr.net/gh")
    if "@main" in url or "@master" in url:
        fail("assets.js", f"CORE is pinned to a branch ({url}) — jsDelivr caches branches"
             " unpredictably, so the live page and your clone can disagree. Use a tag.")
    return url


def topology(name, data, objects, least):
    if data.get("type") != "Topology":
        return fail(name, "not a TopoJSON topology — shared/atlas.js calls topojson.feature on it")
    for key in objects:
        got = data.get("objects", {}).get(key)
        if not got:
            return fail(name, f"no `{key}` object — shared/atlas.js asks for it by name")
        if len(got.get("geometries", [])) < least:
            fail(name, f"{key} has {len(got.get('geometries', []))} geometries, expected at least {least}")


def check_core(base):
    # shared/atlas.js
    topology(f"{base}/atlas/countries-50m.json", get(f"{base}/atlas/countries-50m.json") or {},
             ["countries"], 200)
    topology(f"{base}/atlas/countries-10m.json", get(f"{base}/atlas/countries-10m.json") or {},
             ["countries"], 200)
    topology(f"{base}/atlas/marine-areas.json", get(f"{base}/atlas/marine-areas.json") or {},
             ["areas", "borders"], 150)

    # travel.js groups countries by continent, joining on the atlas's own country names.
    # A name the atlas draws and this lookup has no entry for is a country the map cannot
    # group — the join has to be total, and this is where that is proved end to end.
    atlas = get(f"{base}/atlas/countries-50m.json")
    continents = get(f"{base}/atlas/continents.json")
    if atlas and continents:
        drawn = {g.get("properties", {}).get("name")
                 for g in atlas["objects"]["countries"]["geometries"]}
        missing = sorted(n for n in drawn if n and n not in continents)
        if missing:
            fail("continents.json", f"{len(missing)} countries the atlas draws have no"
                 f" continent: {missing[:4]}")

    # travel/world-map.js
    sky = get(f"{base}/sky/stars.json")
    if sky:
        for key in ("magMax", "stars", "lines", "source"):
            if key not in sky:
                fail("sky/stars.json", f"no `{key}` — travel/world-map.js reads it")
        bad = [s for s in (sky.get("stars") or [])[:500] if len(s) != 3]
        if bad:
            fail("sky/stars.json", "stars are not [ra, dec, mag] triples")


def check_trip(trip, base):
    tid = trip["id"]
    content = get(f"{base}/content.json")
    if not content:
        return
    if not content.get("sections"):
        fail(f"{tid}/content.json", "no sections — trip/content.js renders nothing")

    points = []
    for section in content.get("sections", []):
        for sub in section.get("subsections", []):
            points += sub.get("points", [])
        points += section.get("points", [])
    if not points:
        fail(f"{tid}/content.json", "no points")

    # The join. Every QID a point names must have a record, or the fact panel is blank with
    # no clue why. An absent key and an explicit null are both fine — see shared/places.js.
    places = get(f"{base}/places.json") if any("wikidata" in p for p in points) else None
    linked = [p["wikidata"] for p in points if p.get("wikidata")]
    if linked and not places:
        fail(f"{tid}/places.json", f"{len(linked)} points are linked to Wikidata, but this is missing")
    if places:
        orphans = [q for q in linked if q not in places.get("places", {})]
        if orphans:
            fail(f"{tid}/places.json", f"{len(orphans)} QIDs a point names are not here:"
                 f" {orphans[:4]} — the two files were published out of step")

    # trip/gallery.js builds photo URLs under photos/; check the first one resolves, which
    # is what catches a trip published before its photos were.
    photos = content.get("photos") or []
    if photos:
        first = photos[0] if isinstance(photos[0], str) else photos[0].get("file", "")
        if first and not first.startswith("http"):
            url = f"{base}/photos/{first}"
            try:
                request = urllib.request.Request(url, method="HEAD")
                urllib.request.urlopen(request, timeout=TIMEOUT)
            except Exception as e:  # noqa: BLE001 — any failure here is the same failure
                fail(f"{tid}/photos", f"{first} does not resolve ({e})")
    if content.get("photoRepo"):
        fail(f"{tid}/content.json", "still has photoRepo, but the trip is pinned to an assets"
             " repository — photos are read from photos/ there, so the key is now a lie")


def check_unmigrated(trip):
    """A trip still served from this repository. Only one thing here can break without
    anyone noticing: photos. trip/gallery.js has no default repository name — a guessed one
    renders as a broken image instead of an error — so a trip with photos must say where
    they are, and the repository it names must actually serve them."""
    tid = trip["id"]
    path = ROOT / "travel" / (trip.get("file") or "")
    if not trip.get("file"):
        return  # on the map, not written up
    if not path.exists():
        return fail(f"{tid}", f"travel/{trip['file']} is missing")
    content = json.loads(path.read_text())
    photos = content.get("photos") or []
    if not photos:
        return
    first = photos[0] if isinstance(photos[0], str) else photos[0].get("file", "")
    if first.startswith("http"):
        return
    repo = content.get("photoRepo")
    if not repo:
        return fail(f"{tid}/{trip['file']}", f"{len(photos)} photos but no photoRepo, and no"
                    " assets pin — trip/gallery.js has nowhere to fetch them from")
    slug, _, branch = repo.partition("@")
    url = f"https://cdn.jsdelivr.net/gh/{slug}@{branch or 'main'}/{first}"
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=TIMEOUT)
    except Exception as e:  # noqa: BLE001
        fail(f"{tid}/photos", f"photoRepo {repo!r} does not serve {first} ({e})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", action="store_true", help="check assets.core only")
    args = parser.parse_args()

    base = core_pin()
    print(f"core  {base}")
    check_core(base)

    if not args.core:
        for trip in json.loads(INDEX.read_text()):
            pin = trip.get("assets")
            if not pin:
                check_unmigrated(trip)
                continue
            if "@" not in pin or pin.endswith("@main"):
                fail(f'{trip["id"]}', f"assets pin {pin!r} is not owner/repo@tag")
                continue
            trip_base = f"https://cdn.jsdelivr.net/gh/{pin}"
            print(f"trip  {trip_base}")
            check_trip(trip, trip_base)

    if problems:
        print("\n" + "\n".join("FAIL " + p for p in problems), file=sys.stderr)
        raise SystemExit(1)
    print("\nevery pin resolves and serves what the site reads")


if __name__ == "__main__":
    main()
