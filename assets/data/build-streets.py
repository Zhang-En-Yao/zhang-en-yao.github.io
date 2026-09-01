#!/usr/bin/env python3
"""Regenerate travel/streets/<trip-id>.json — real street geometry for a trip's cluster maps.

Each cluster map on a trip page (assets/js/trip.js) draws a section's spots over a background
of real streets, fetched from OpenStreetMap's Overpass API. Querying Overpass live on every
page view is both slow (a few seconds per cluster, and their public instance asks callers not
to burst it with concurrent requests) and needless — the streets around a fixed set of
coordinates do not change from one visitor to the next. So this script does that fetching
once, offline, and the page just loads the resulting static file.

The bounding box for each cluster must match trip.js's own math exactly (AREA_SIZE,
AREA_MARGIN, AREA_MIN_SPAN_LON, CLUSTER_CAP_M) — a wider box here would fetch streets that run
off the edge of the rendered map; a narrower one would miss streets inside it that the map
actually shows. If those constants change in trip.js, mirror the change here too.

A trip's maps come from one of two places, depending on its `index.json` entry's `file`:

  - `<id>.json` (current): `maps_for_json_trip()` walks the trip's own content file's
    `sections`/`subsections` — the same structure assets/js/trip.js's `renderTripContent`
    renders — and `cluster_points()` splits a subsection's points into however many maps that
    actually takes (mirrors trip.js's own `clusterPoints`). Points and prose live in the one
    file here, so there is nothing for a heading in one place to drift out of sync with a
    heading in another; the older `check-areas.py` lint has nothing left to check for a trip
    in this format.

  - `<id>.md` (legacy): `maps_for_legacy_trip()` reads `index.json`'s own `areas` array, the
    original design — a heading has to name-match a rendered Markdown heading exactly, and a
    heading whose points span too far apart for one map has to be hand-split into several
    `area` entries sharing that heading. No trip currently uses this path, but it stays
    supported for one that hasn't been migrated to a JSON content file yet.

Every map, from either path, funnels through the same `PROFILES` lookup and the same
`fetch_streets()` call — the only thing that varies is which profile a map's `route`-ness
picks, never a separate code path.

Run from the repo root whenever a trip's content changes — already-fetched maps are skipped,
so a plain re-run only fills in what's new:

    python3 assets/data/build-streets.py

Force a re-fetch of one map, or every map under a heading, instead of hand-editing the cached
JSON (match a map's key as printed while fetching — a section heading alone for a route, or
"Section / Subsection" for a city map):

    python3 assets/data/build-streets.py --refetch "Camino Francés" "Madrid / Mayrit → Madrid of the Golden Age"

Force a full re-fetch of everything, or of one trip's maps only:

    python3 assets/data/build-streets.py --all
    python3 assets/data/build-streets.py --all --trip 202610222105
"""

import argparse
import json
import math
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
TRAVEL_DIR = HERE.parent.parent / "travel"
INDEX = TRAVEL_DIR / "index.json"
OUT_DIR = TRAVEL_DIR / "streets"

# The primary instance is the one usually reached for; the mirror is a fallback for when
# it's unreachable (its firewall appears to temporarily block IPs that send it a burst of
# requests, which is easy to trigger by hand while developing against it).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
REQUEST_GAP_S = 4  # Politeness gap between requests to the shared public instance.

# Mirrors AREA_SIZE / AREA_PAD / AREA_MARGIN / AREA_MIN_SPAN_LON in assets/js/trip.js. Every
# area map — a city cluster or the Camino route alike — is fetched and rendered on the same
# square canvas; trip.js no longer fits each cluster's own aspect ratio, on purpose, so
# there's nothing to mirror here beyond the one fixed size.
AREA_SIZE = 700
AREA_MIN_SPAN_LON = 0.004

# Mirrors trip.js's own CLUSTER_CAP_M — the two must stay equal, or a subsection splits into a
# different number of maps here than trip.js renders, and a map's key stops matching between
# fetch time and page-load time.
CLUSTER_CAP_M = 3500

# Mirrors trip.js's own SAME_SITE_M — see its comment. A route section pools every subsection's
# points before fetching, same as trip.js pools them before rendering; without the identical
# dedup here, this script would ask Overpass for a box built from points trip.js never actually
# plots (harmless for the box's size in practice, since duplicates sit meters apart, but the two
# should agree on what a "point" is on principle, not by coincidence of scale).
SAME_SITE_M = 300

# Every map resolves to one of these by name — a lookup instead of a scattered
# `ROUTE_X if is_route else X` at every call site. Adding a new kind of map later (say, a day
# hike that wants its own balance) means adding an entry here, not a new parameter threaded
# through fetch calls.
PROFILES = {
    # A city cluster: a neighbourhood's worth of spots close enough together that the margin
    # only needs to buy breathing room around them, and the full local street grid is exactly
    # what a reader wants to see underneath.
    #
    # Real streets, not every mapped path — steps/track/service account for most of the rest
    # of a dense old town's way count (footway/path/cycleway used to be lumped in with them
    # here too, at roughly 60% of Toledo's ways measured) while adding little a reader can
    # use at this map's scale: a few thousand individual staircases, driveways, and unpaved
    # tracks turn that into visual noise, not detail. `footway`/`path`/`cycleway` are kept
    # despite a similar cost (footway/path alone ~3.4x more ways, measured on Eixample's
    # grid; cycleway added another 919 ways just in the Waterfront's box) because without
    # them a plaza, a park path, or a seafront promenade — often not tagged any other way —
    # reads as a blank patch on the map with no street under it at all, which reads as broken
    # rather than as a quiet park or a bike path. `_link` variants (a highway's own on/off
    # ramps) are kept alongside their parent type.
    "city": {
        "margin": 1.6,
        "highway_types": (
            "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
            "living_street|pedestrian|footway|path|cycleway|motorway_link|trunk_link|"
            "primary_link|secondary_link|tertiary_link"
        ),
    },
    # A route (the Camino) covers a whole region, not a few blocks — its own town-scale
    # streets (residential, pedestrian, living_street…) would mean querying every lane in
    # every village along ~115km of Galicia, a huge answer for what's meant to be background
    # context for a line connecting eight dots. Even "motorway and up through primary" turned
    # out to still mean 40,000+ points across a box this size — long rural roads carry a lot
    # of vertices — so this stays well short of full local detail.
    #
    # primary|secondary alone reads as "just the trunk roads" — Galicia's actual N-547/N-540
    # rather than the country lanes and waymarked trail the Camino itself mostly follows
    # between villages, so the map ended up sparse to the point of looking broken. `tertiary`
    # closes most of that gap at a manageable cost (~3,150 ways / ~46k points over the
    # route's box, measured); `path` — the tag that actually carries long rural stretches of
    # the pilgrim trail itself, separate from the road network — adds roughly another 3,400.
    # One more step down, `unclassified` and `track` — Spain's tags for its smallest rural
    # connector roads and farm tracks — time out the public Overpass instance outright even
    # on a bare `out count`, so those stay excluded rather than chased.
    #
    # The margin is also its own, smaller number: a route's own points already span the
    # whole region, so the same 60%-of-span margin a compact cluster needs for breathing room
    # instead multiplies an already-huge query area. This only shrinks the *query* box, not
    # the map's rendered frame (still the "city" profile's margin, in trip.js's own
    # AREA_MARGIN) — streets stop appearing a bit before the frame's outer edge, which is a
    # fair trade against querying half of Galicia for a road that's a similar distance beyond
    # it.
    "route": {
        "margin": 1.15,
        "highway_types": "primary|secondary|tertiary|path|primary_link|secondary_link|tertiary_link",
    },
}


def cluster_bounds(points, margin, min_span_lon, w, h):
    """Mirrors trip.js's clusterBounds()."""
    lons = [p["lon"] for p in points]
    lats = [p["lat"] for p in points]
    west, east = min(lons), max(lons)
    south, north = min(lats), max(lats)
    span_lon = max((east - west) * margin, min_span_lon)
    span_lat = max((north - south) * margin, min_span_lon * h / w)
    cx, cy = (west + east) / 2, (south + north) / 2
    return {
        "west": cx - span_lon / 2,
        "east": cx + span_lon / 2,
        "south": cy - span_lat / 2,
        "north": cy + span_lat / 2,
    }


def haversine_m(a, b):
    R = 6371000
    lat1, lon1, lat2, lon2 = map(math.radians, [a["lat"], a["lon"], b["lat"], b["lon"]])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def cluster_points(points, cap_m):
    """Mirrors trip.js's clusterPoints(): union-find over the distance cap, so two points end
    up in the same group the moment anything chains them together within it, not only when
    they are themselves within the cap of each other."""
    n = len(points)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if haversine_m(points[i], points[j]) <= cap_m:
                union(i, j)

    order, groups = [], {}
    for i in range(n):
        r = find(i)
        if r not in groups:
            groups[r] = []
            order.append(r)
        groups[r].append(points[i])
    return [groups[r] for r in order]


def fetch_streets(bounds, highway_types):
    query = (
        "[out:json][timeout:25];"
        f'way["highway"~"^({highway_types})$"]({bounds["south"]},{bounds["west"]},{bounds["north"]},{bounds["east"]});'
        "out geom;"
    )
    data = urllib.parse.urlencode({"data": query}).encode()
    # Overpass's Apache front end 406s Python's default `Python-urllib/…` User-Agent
    # specifically — a browser's fetch() never carries that header and is unaffected, this
    # only matters because this script itself is the one talking to Overpass here.
    headers = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "curl/8.4.0"}

    # Each instance gets a couple of tries (a 504 or a burst-triggered 429 is usually
    # transient) before falling through to the next one in OVERPASS_URLS.
    last_err = None
    for url in OVERPASS_URLS:
        for attempt in range(2):
            if attempt:
                time.sleep(REQUEST_GAP_S * (attempt + 1))
            try:
                req = urllib.request.Request(url, data=data, method="POST", headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:
                    result = json.load(r)
                ways = [e for e in result.get("elements", []) if e.get("type") == "way" and e.get("geometry")]
                # Only the coordinates are kept — Overpass's tags, ids, and bounds are of no
                # use to a page that just draws lines. Rounded to 5 decimal places (~1m) —
                # Overpass's own 7 (~1cm) is far finer than a single pixel at this map's
                # scale, and JSON stores a float as its full decimal text, so the extra
                # digits are dead weight (a modest cut on their own; most of the file's size
                # is simply how many ways and points a dense old town has).
                return [
                    [[round(n["lon"], 5), round(n["lat"], 5)] for n in w["geometry"]]
                    for w in ways
                ]
            except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
                # OSError catches a reset/dropped connection, which is not a URLError even
                # though it is exactly the kind of transient failure worth retrying —
                # `ConnectionResetError` (a plain OSError subclass) took the whole script
                # down the first time this ran without it.
                last_err = e
    raise last_err


def fetch_for_profile(points, profile_name):
    profile = PROFILES[profile_name]
    bounds = cluster_bounds(points, profile["margin"], AREA_MIN_SPAN_LON, AREA_SIZE, AREA_SIZE)
    return fetch_streets(bounds, profile["highway_types"])


def maps_for_json_trip(content):
    """Yields (key, points, profile_name) for every map assets/js/trip.js's
    `renderTripContent` will draw from this trip's JSON content file — mirroring
    `sectionHtml`/`subsectionMapsHtml` there exactly, so a map's key here is the key trip.js
    looks `streetWays` up under."""
    for section in content.get("sections", []):
        subs = section.get("subsections", [])
        if section.get("route"):
            pooled = [p for s in subs for p in s.get("points", [])]
            points = [group[0] for group in cluster_points(pooled, SAME_SITE_M)]
            if points:
                yield section["heading"], points, "route"
            continue
        for sub in subs:
            points = sub.get("points", [])
            if not points:
                continue
            base = f'{section["heading"]} / {sub["heading"]}'
            groups = cluster_points(points, CLUSTER_CAP_M)
            for i, group in enumerate(groups):
                key = base if len(groups) == 1 else f"{base} #{i + 1}"
                yield key, group, "city"


def maps_for_legacy_trip(areas):
    """Yields (key, points, profile_name) for the older Markdown-plus-`index.json`-`areas`
    format — see the module docstring's legacy note. A heading covering more than one `area`
    entry (hand-split, in this format, rather than computed by `cluster_points`) is
    disambiguated the same way assets/js/trip.js's legacy `streetsKey()` does."""
    for area in areas:
        same_heading = [a for a in areas if a["heading"] == area["heading"]]
        key = area["heading"] if len(same_heading) == 1 else f"{area['heading']} #{same_heading.index(area) + 1}"
        yield key, area["points"], "route" if area.get("route") else "city"


def maps_for_trip(trip):
    file = trip.get("file", "")
    if file.endswith(".json"):
        path = TRAVEL_DIR / file
        if not path.exists():
            return []
        return list(maps_for_json_trip(json.loads(path.read_text())))
    areas = [a for a in trip.get("areas", []) if a.get("points")]
    return list(maps_for_legacy_trip(areas)) if areas else []


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--trip", metavar="TRIP_ID",
        help="Only touch this trip's maps (matches travel/index.json's `id`). Default: every trip with maps.",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--refetch", metavar="KEY", nargs="+",
        help="Drop cached maps whose key equals this, or starts with this followed by ' #' or "
             "' / ' — so naming a whole section's heading re-fetches every map under it, and "
             "naming one 'Section / Subsection' re-fetches just that one (every part of it, "
             "if it was itself split). Re-fetches instead of skipping as already-done.",
    )
    group.add_argument(
        "--all", action="store_true",
        help="Drop every cached map first (scoped by --trip if given) — a full re-fetch, "
             "e.g. after changing a PROFILES entry.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    trips = json.loads(INDEX.read_text())
    OUT_DIR.mkdir(exist_ok=True)

    for trip in trips:
        if args.trip and trip["id"] != args.trip:
            continue
        maps = maps_for_trip(trip)
        if not maps:
            continue

        out_path = OUT_DIR / f"{trip['id']}.json"
        # Resumable: a map already present in a previous run's output is not re-fetched.
        # Handy in general, and specifically because Overpass's public instances have, in
        # practice, temporarily firewalled this script mid-run more than once. --refetch/--all
        # opt specific maps (or everything) back into `pending` below instead of requiring the
        # cached file to be hand-edited first.
        out = json.loads(out_path.read_text()) if out_path.exists() else {}
        if args.all:
            out = {}
        elif args.refetch:
            for name in args.refetch:
                out.pop(name, None)
                for key in [k for k in out if k.startswith(f"{name} #") or k.startswith(f"{name} / ")]:
                    del out[key]
        pending = [(key, points, profile) for key, points, profile in maps if key not in out]

        for i, (key, points, profile_name) in enumerate(pending):
            print(f"{trip['id']} / {key} ({profile_name}): querying Overpass…")
            try:
                out[key] = fetch_for_profile(points, profile_name)
                print(f"  {len(out[key])} ways")
                out_path.write_text(json.dumps(out, ensure_ascii=False) + "\n")
            except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
                print(f"  FAILED: {e} — leaving this cluster without streets")
            if i < len(pending) - 1:
                time.sleep(REQUEST_GAP_S)

        if not out:
            continue
        print(f"{out_path}: {sum(len(v) for v in out.values())} ways total")


if __name__ == "__main__":
    main()
