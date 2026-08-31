#!/usr/bin/env python3
"""Regenerate travel/streets/<trip-id>.json — real street geometry for a trip's cluster maps.

Each cluster map on a trip page (assets/js/trip.js, insertAreaMaps) draws a section's spots
over a background of real streets, fetched from OpenStreetMap's Overpass API. Querying
Overpass live on every page view is both slow (a few seconds per cluster, and their public
instance asks callers not to burst it with concurrent requests) and needless — the streets
around a fixed set of coordinates do not change from one visitor to the next. So this script
does that fetching once, offline, and the page just loads the resulting static file.

The bounding box for each cluster must match trip.js's own math exactly (AREA_SIZE,
AREA_MARGIN, AREA_MIN_SPAN_LON) — a wider box here would fetch streets that run off the edge
of the rendered map; a narrower one would miss streets inside it that the map actually
shows. If those constants change in trip.js, mirror the change here too.

Run from the repo root whenever a trip's `areas` change:

    python3 assets/data/build-streets.py
"""

import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
INDEX = HERE.parent.parent / "travel" / "index.json"
OUT_DIR = HERE.parent.parent / "travel" / "streets"

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
AREA_MARGIN = 1.6
AREA_MIN_SPAN_LON = 0.004


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


# Real streets, not every mapped path — footway/steps/path/track/service account for most
# of a dense old town's way count (roughly 60% of Toledo's, measured) while adding little a
# reader can use at this map's scale: a map is meant to say "here is the street grid", and a
# few thousand individual staircases and alley segments turn that into visual noise, not
# detail, on top of being the majority of what makes the fetched file and the rendered SVG
# heavy. `_link` variants (a highway's own on/off ramps) are kept alongside their parent type.
HIGHWAY_TYPES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|"
    "pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
)

# A route map (the Camino) covers a whole region, not a few blocks — its own town-scale
# streets (residential, pedestrian, living_street…) would mean querying every lane in every
# village along ~115km of Galicia, a huge answer for what's meant to be background context
# for a line connecting eight dots. Even "motorway and up through primary" turned out to
# still mean 40,000+ points across a box this size — long rural roads carry a lot of
# vertices — so this stays a class or two up from full local detail.
ROUTE_HIGHWAY_TYPES = "primary|secondary|primary_link|secondary_link"
# A route's own points already span the whole region, so the same 60%-of-span margin a
# compact cluster needs for breathing room instead multiplies an already-huge query area.
# This only shrinks the *query* box, not the map's rendered frame (still AREA_MARGIN in
# trip.js) — streets stop appearing a bit before the frame's outer edge, which is a fair
# trade against querying half of Galicia for a road that's a similar distance beyond it.
ROUTE_STREET_MARGIN = 1.15


def fetch_streets(bounds, route=False):
    highway_types = ROUTE_HIGHWAY_TYPES if route else HIGHWAY_TYPES
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


def main():
    trips = json.loads(INDEX.read_text())
    OUT_DIR.mkdir(exist_ok=True)

    for trip in trips:
        areas = [a for a in trip.get("areas", []) if a.get("points")]
        if not areas:
            continue

        out_path = OUT_DIR / f"{trip['id']}.json"
        # Resumable: a cluster already present in a previous run's output is not re-fetched.
        # Handy in general, and specifically because Overpass's public instances have, in
        # practice, temporarily firewalled this script mid-run more than once.
        out = json.loads(out_path.read_text()) if out_path.exists() else {}
        pending = [a for a in areas if a["heading"] not in out]

        for i, area in enumerate(pending):
            is_route = bool(area.get("route"))
            margin = ROUTE_STREET_MARGIN if is_route else AREA_MARGIN
            bounds = cluster_bounds(area["points"], margin, AREA_MIN_SPAN_LON, AREA_SIZE, AREA_SIZE)
            print(f"{trip['id']} / {area['heading']}: querying Overpass…")
            try:
                out[area["heading"]] = fetch_streets(bounds, route=is_route)
                print(f"  {len(out[area['heading']])} ways")
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
