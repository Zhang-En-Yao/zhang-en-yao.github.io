#!/usr/bin/env python3
"""Lint travel/index.json's `areas` against each trip's own Markdown and coordinates.

Where a POI is plotted comes from decisions made by hand when a trip's `areas` are written,
that this script makes explicit and checkable instead of left as judgment calls buried in the
data:

  1. WHICH SECTION a POI belongs to is answered by the trip's own prose, not re-decided here:
     an area is one `##`/`###` Markdown heading (assets/js/trip.js matches an area to a
     rendered page section by that exact heading text), and its candidate POIs are the bullets
     written under that heading — `- **Name** — Kind · Date — Coordinates: \\`lat, lon\\`` — or,
     for an older trip written before that convention, `####` sub-headings with no coordinates
     of their own. A trip's table of contents already reflects a grouping a human made; this
     script's job is only to confirm `travel/index.json` didn't drift from it.

  2. WHICH OF those POIs actually get a dot on that section's map is a distance call: a
     cluster map is framed on real walking distance (trip.js's AREA_MARGIN/AREA_SIZE fit a
     neighbourhood, not a city), so a POI belongs on a given map only if it's within
     CLUSTER_CAP_M of that map's other points. That cap (3.5km) is not arbitrary — it's the
     largest span any current legitimate single-map cluster actually reaches (The Waterfront,
     Port Vell to Poblenou, ~3.4km), with slight headroom. A heading whose written-up POIs
     don't all fit inside that cap isn't a bug to silently accept or reject — it's supposed to
     become more than one `area` entry sharing that same heading text (trip.js renders each as
     its own map, in the order given), and this script checks each of those split maps against
     the cap independently, the same way it would a heading that never needed splitting.

  3. WHICH EXACT COORDINATES an area uses should equal the Markdown's own bullet, since a
     trip's `.md` is the one place a human actually looks up and types a place's coordinates —
     `travel/index.json` copies them, by hand, and a hand copy can transpose a digit. Where a
     bullet has coordinates, this script compares them to the matching point's and flags any
     drift past COORD_TOLERANCE_M.

A Markdown section can also be handled in aggregate rather than per its own sub-headings: if a
`##` heading's own text is itself used as an `area.heading` (the Camino: the day-by-day `###`
stops underneath it — Sarria, Portomarín, … — are its narrative, but the *map* is one combined
route drawn at the `## Camino Francés` level), every POI written up anywhere under that `##` is
pooled and checked only loosely — every plotted point must trace back to some real bullet in
the section, but not every bullet has to be plotted (a route deliberately picks one
representative stop per day, not every landmark mentioned that day) — and the distance cap
does not apply (a route is the one kind of area meant to span a whole region).

This never edits travel/index.json; it only reports. Run it after changing a trip's `areas`
or its Markdown:

    python3 assets/data/check-areas.py
    python3 assets/data/check-areas.py --trip 202610222105
    python3 assets/data/check-areas.py --cap-m 4000
"""

import argparse
import json
import math
import pathlib
import re

HERE = pathlib.Path(__file__).parent
INDEX = HERE.parent.parent / "travel" / "index.json"
MD_DIR = HERE.parent.parent / "travel"

# The largest span any current legitimate single-map cluster actually reaches — see the module
# docstring. A POI further than this from the rest of its map's points is flagged as an outlier
# rather than assumed to belong on that particular map.
CLUSTER_CAP_M = 3500

# Generous on purpose: this is here to catch a transposed or dropped digit (typically hundreds
# of metres to kilometres off), not to police rounding. `build-streets.py` itself rounds to
# ~1m, so real drift is either ~0 or clearly a mistake, rarely something in between.
COORD_TOLERANCE_M = 50

H2_RE = re.compile(r"^## (.+?)\s*$")
H3_RE = re.compile(r"^### (.+?)\s*$")
H4_RE = re.compile(r"^#### (.+?)\s*$")
BULLET_RE = re.compile(r"^- \*\*(.+?)\*\*.*Coordinates: `([\-\d.]+),\s*([\-\d.]+)`\s*$")


def parse_markdown(text):
    """Two dicts keyed by every `##`/`###` heading in the file:
      - poi_lists[heading]: [{'name', 'lat', 'lon'}], lat/lon `None` for an old-style `####`
        sub-heading with no coordinates of its own.
      - parent_h2[heading]: the enclosing `##` text, or `None` when `heading` is itself a `##`.
    """
    poi_lists, parent_h2 = {}, {}
    cur_h2 = None
    cur_heading = None
    for line in text.splitlines():
        m2, m3, m4 = H2_RE.match(line), H3_RE.match(line), H4_RE.match(line)
        if m2:
            cur_h2 = cur_heading = m2.group(1)
            poi_lists.setdefault(cur_heading, [])
            parent_h2[cur_heading] = None
            continue
        if m3:
            cur_heading = m3.group(1)
            poi_lists.setdefault(cur_heading, [])
            parent_h2[cur_heading] = cur_h2
            continue
        if m4 and cur_heading is not None:
            poi_lists[cur_heading].append({"name": m4.group(1), "lat": None, "lon": None})
            continue
        mb = BULLET_RE.match(line)
        if mb and cur_heading is not None:
            name, lat, lon = mb.group(1), float(mb.group(2)), float(mb.group(3))
            poi_lists[cur_heading].append({"name": name, "lat": lat, "lon": lon})
    return poi_lists, parent_h2


def name_tokens(name):
    return set(re.findall(r"[\w']+", name.lower()))


def names_match(poi_name, point_name):
    """True if a written-up POI and a plotted point's name plausibly name the same place.
    Exact text rarely matches — "Toledo Cathedral (Catedral Primada)" is shortened to "Toledo
    Cathedral" on the map, "El Born Centre de Cultura i Memòria" becomes "El Born CCM" — so
    this accepts either name containing the other, or the two sharing at least two words (one
    word, for a single-word name)."""
    if poi_name == point_name:
        return True
    if poi_name in point_name or point_name in poi_name:
        return True
    a, b = name_tokens(poi_name), name_tokens(point_name)
    need = 2 if min(len(a), len(b)) >= 2 else 1
    return len(a & b) >= need


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def point_dist_m(a, b):
    return haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])


def check_cluster_span(heading, points, warn):
    if len(points) < 2:
        return
    worst = None
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            d = point_dist_m(points[i], points[j])
            if worst is None or d > worst[0]:
                worst = (d, points[i]["name"], points[j]["name"])
    if worst[0] > CLUSTER_CAP_M:
        d, a, b = worst
        warn(f"{heading}: {a!r} <-> {b!r} are {d / 1000:.1f}km apart — past the "
             f"{CLUSTER_CAP_M / 1000:.1f}km cluster cap, split this heading into another area "
             f"or double check one of them belongs elsewhere")


def check_coords(heading, point, pois, warn):
    """The point's coordinates against whichever written-up POI it names — flags hand-copy
    drift past COORD_TOLERANCE_M. Prefers an exact name match (what a point copied straight
    from its bullet, the normal case, always gets) over `names_match`'s fuzzy one: two POIs
    that legitimately share a generic qualifier — "Museo del Prado" / "Museo del Greco" both
    contain "Museo del" — can satisfy the fuzzy check against each other, which is fine for
    "is this POI plotted somewhere" but wrong here, where it would compare a point against the
    coordinates of an unrelated place across town. When only fuzzy candidates exist, the
    nearest one is the most plausible match rather than whichever happens to sort first.
    Skipped for an old-style `####` POI, which has no coordinates of its own to compare."""
    dated = [p for p in pois if p["lat"] is not None]
    exact = [p for p in dated if p["name"] == point["name"]]
    candidates = exact or [p for p in dated if names_match(p["name"], point["name"])]
    if not candidates:
        return
    best = min(candidates, key=lambda p: point_dist_m(point, p))
    d = point_dist_m(point, best)
    if d > COORD_TOLERANCE_M:
        warn(f"{heading}: {point['name']!r} is {d:.0f}m from its own Markdown bullet's "
             f"coordinates — index.json vs the .md have drifted, check for a hand-copy typo")


def check_regular_heading(heading, pois, areas_here, warn):
    """A heading not handled in aggregate: every one of its areas (usually one, more if the
    heading was split across several maps) is checked against the same pooled POI list, plus
    each area's own internal span against CLUSTER_CAP_M."""
    all_points = [p for a in areas_here for p in a.get("points", [])]
    for poi in pois:
        if not any(names_match(poi["name"], p["name"]) for p in all_points):
            warn(f"{heading}: {poi['name']!r} is written up here but not plotted on any of "
                 f"this heading's map(s) — confirm it either belongs on one (add coordinates) "
                 f"or is correctly left off (same site as a point already there, or genuinely "
                 f"too far from the rest)")

    for area in areas_here:
        points = area.get("points", [])
        check_cluster_span(heading, points, warn)
        for p in points:
            check_coords(heading, p, pois, warn)


def check_aggregate_heading(h2_heading, pooled_pois, areas_here, warn):
    """A `##` handled as one combined section (the Camino): looser by design — not every named
    stop needs a dot, but every dot needs to trace back to a real stop, and its coordinates
    should still match whichever bullet it represents."""
    for area in areas_here:
        for p in area.get("points", []):
            if not any(names_match(poi["name"], p["name"]) for poi in pooled_pois):
                warn(f"{h2_heading}: plotted point {p['name']!r} doesn't match any POI written "
                     f"up anywhere in this section — typo, or a stale point left over from a "
                     f"previous edit?")
            check_coords(h2_heading, p, pooled_pois, warn)


def main():
    global CLUSTER_CAP_M
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trip", metavar="TRIP_ID", help="Only check this trip. Default: every trip with areas.")
    parser.add_argument("--cap-m", type=float, default=CLUSTER_CAP_M, metavar="METERS",
                         help=f"Cluster-span cap in metres (default {CLUSTER_CAP_M:.0f}, see the module docstring).")
    args = parser.parse_args()
    CLUSTER_CAP_M = args.cap_m

    trips = json.loads(INDEX.read_text())
    total_warnings = 0

    for trip in trips:
        if args.trip and trip["id"] != args.trip:
            continue
        areas = trip.get("areas", [])
        if not areas:
            continue

        md_path = MD_DIR / f"{trip['id']}.md"
        if not md_path.exists():
            print(f"{trip['id']}: has areas but no {md_path.name} to check them against — skipping")
            continue
        poi_lists, parent_h2 = parse_markdown(md_path.read_text())

        areas_by_heading = {}
        for area in areas:
            areas_by_heading.setdefault(area["heading"], []).append(area)

        # A `##` is aggregate when its own heading text is itself an area.heading — its `###`
        # children are then narrative only, not individually mapped, and get skipped below.
        aggregate_h2s = {h for h in poi_lists if parent_h2.get(h) is None and h in areas_by_heading}

        trip_warnings = []
        checked_headings = set()

        for h2 in aggregate_h2s:
            pooled = list(poi_lists.get(h2, []))
            for h3, parent in parent_h2.items():
                if parent == h2:
                    pooled += poi_lists.get(h3, [])
                    checked_headings.add(h3)
            check_aggregate_heading(h2, pooled, areas_by_heading.get(h2, []), trip_warnings.append)
            checked_headings.add(h2)

        for heading, pois in poi_lists.items():
            if heading in checked_headings:
                continue
            checked_headings.add(heading)
            areas_here = areas_by_heading.get(heading, [])
            if not areas_here:
                if pois:
                    print(f"{trip['id']}: {heading!r} has {len(pois)} POIs but no area/map — "
                          f"fine if deliberate (e.g. a scattered \"Elsewhere\" section)")
                continue
            check_regular_heading(heading, pois, areas_here, trip_warnings.append)

        # An area.heading with no matching Markdown heading at all — trip.js will silently
        # find nothing to insert its map after.
        for heading in areas_by_heading:
            if heading not in poi_lists:
                trip_warnings.append(f"{heading!r}: no matching ## or ### heading in this "
                                      f"trip's Markdown — trip.js will silently skip this area's map")

        if trip_warnings:
            print(f"{trip['id']}:")
            for w in trip_warnings:
                print(f"  - {w}")
            total_warnings += len(trip_warnings)
        else:
            print(f"{trip['id']}: clean ({len(areas)} areas)")

    if total_warnings:
        print(f"\n{total_warnings} warning(s) — see above. Nothing was changed.")


if __name__ == "__main__":
    main()
