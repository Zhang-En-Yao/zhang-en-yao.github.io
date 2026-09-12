#!/usr/bin/env python3
"""Regenerate stars.json — the real sky drawn in the world map's empty polar bands.

The travel map is square, but the projected world is about 2:1, so a band of about a
quarter of the height is left over above the Arctic and below Antarctica. Rather than
invent something to put there, those bands carry an actual star chart, centred on the
north and south celestial poles.

Two catalogues supply the chart:

  HYG v4.4                    every star to magnitude 6, from its official Codeberg home
  constellations.lines.json   the IAU constellation figures from d3-celestial

HYG expresses right ascension in hours, so it is converted to degrees (and wrapped to
the [-180, 180] range used by d3-geo). The constellation data is already in degrees and
ordered [lon, lat], so d3-geo projects it just like the countries.

Trimmed to magnitude 6 — the naked-eye limit under a dark sky. Each band spans a whole
hemisphere, so anything brighter leaves the corners looking empty. The limit is written
into the file as magMax; world-map.js reads it back to size and fade each star.

Run from the repo root when you want a different magnitude limit:

    python3 assets/data/build-stars.py
"""

import csv
import gzip
import io
import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "stars.json"
# HYG's official Codeberg media endpoint resolves its Git LFS-backed catalogue.
HYG_URL = (
    "https://codeberg.org/astronexus/hyg/media/branch/main/"
    "data/hyg/CURRENT/hyg_v44.csv.gz"
)
# Pinned release first, with the d3-celestial repository as a fallback.
CELESTIAL_BASES = (
    "https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data",
    "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data",
)

MAG_MAX = 6.0


def fetch_celestial(name):
    for base in CELESTIAL_BASES:
        try:
            with urllib.request.urlopen(f"{base}/{name}", timeout=30) as response:
                return json.load(response)
        except OSError as error:
            print(f"  {base} unreachable ({error})")
    raise SystemExit(f"could not download {name}")


def fetch_hyg():
    try:
        with urllib.request.urlopen(HYG_URL, timeout=60) as response:
            with gzip.GzipFile(fileobj=io.BytesIO(response.read())) as archive:
                return list(csv.DictReader(io.TextIOWrapper(archive, encoding="utf-8")))
    except OSError as error:
        raise SystemExit(f"could not download HYG v4.4 ({error})") from error


def main():
    stars = []
    for star in fetch_hyg():
        mag = float(star["mag"])
        if mag > MAG_MAX:
            continue
        ra = float(star["ra"]) * 15
        if ra > 180:
            ra -= 360
        dec = float(star["dec"])
        # 2 decimals is 36 arcseconds, which is a twentieth of a pixel on the drawn chart.
        stars.append([round(ra, 2), round(dec, 2), round(mag, 1)])

    # Faintest first, so the brightest stars are painted last and sit on top.
    stars.sort(key=lambda s: -s[2])

    lines = []
    for feature in fetch_celestial("constellations.lines.json")["features"]:
        paths = [[[round(ra, 2), round(dec, 2)] for ra, dec in segment]
                 for segment in feature["geometry"]["coordinates"]]
        if paths:
            lines.append({"id": feature["id"], "paths": paths})

    OUT.write_text(json.dumps({
        "magMax": MAG_MAX,
        "source": "HYG v4.4 (astronexus, CC BY-SA 4.0); constellation lines: d3-celestial (Olaf Frohn, BSD-3-Clause)",
        "stars": stars,
        "lines": lines,
    }, separators=(",", ":")) + "\n")

    print(f"{OUT.name}: {len(stars)} stars to magnitude {MAG_MAX}, "
          f"{len(lines)} constellation figures, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
