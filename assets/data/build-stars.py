#!/usr/bin/env python3
"""Regenerate stars.json — the real sky drawn in the world map's empty polar bands.

The travel map is square, but the projected world is about 2:1, so a band of about a
quarter of the height is left over above the Arctic and below Antarctica. Rather than
invent something to put there, those bands carry an actual star chart, centred on the
north and south celestial poles.

Two catalogues, both from d3-celestial (Olaf Frohn, BSD-3-Clause), which in turn draws on
the HYG database and Hipparcos:

  stars.6.json               every star to magnitude 6, as [right ascension, declination]
  constellations.lines.json  the IAU constellation figures, as MultiLineStrings

Both are already in degrees and ordered [lon, lat], so d3-geo projects them the same way
it projects the countries — right ascension stands in for longitude, declination for
latitude.

Trimmed to magnitude 6 — the naked-eye limit under a dark sky. Each band spans a whole
hemisphere, so anything brighter leaves the corners looking empty. The limit is written
into the file as magMax; world-map.js reads it back to size and fade each star.

Run from the repo root when you want a different magnitude limit:

    python3 assets/data/build-stars.py
"""

import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "stars.json"
# The pinned release first, the repository it is built from as a fallback for networks
# that cannot reach the CDN.
BASES = (
    "https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data",
    "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data",
)

MAG_MAX = 6.0


def fetch(name):
    for base in BASES:
        try:
            with urllib.request.urlopen(f"{base}/{name}", timeout=30) as response:
                return json.load(response)
        except OSError as error:
            print(f"  {base} unreachable ({error})")
    raise SystemExit(f"could not download {name}")


def main():
    stars = []
    for feature in fetch("stars.6.json")["features"]:
        mag = feature["properties"]["mag"]
        if mag > MAG_MAX:
            continue
        ra, dec = feature["geometry"]["coordinates"]
        # 2 decimals is 36 arcseconds, which is a twentieth of a pixel on the drawn chart.
        stars.append([round(ra, 2), round(dec, 2), round(mag, 1)])

    # Faintest first, so the brightest stars are painted last and sit on top.
    stars.sort(key=lambda s: -s[2])

    lines = []
    for feature in fetch("constellations.lines.json")["features"]:
        paths = [[[round(ra, 2), round(dec, 2)] for ra, dec in segment]
                 for segment in feature["geometry"]["coordinates"]]
        if paths:
            lines.append({"id": feature["id"], "paths": paths})

    OUT.write_text(json.dumps({
        "magMax": MAG_MAX,
        "source": "d3-celestial (Olaf Frohn, BSD-3-Clause), from the HYG database and Hipparcos",
        "stars": stars,
        "lines": lines,
    }, separators=(",", ":")) + "\n")

    print(f"{OUT.name}: {len(stars)} stars to magnitude {MAG_MAX}, "
          f"{len(lines)} constellation figures, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
