#!/usr/bin/env python3
"""Regenerate marine-areas.json for the travel world's named waters.

Natural Earth's 1:50m marine polygons identify oceans, seas, gulfs, bays, straits,
channels and sounds. The output retains only the geometry and the properties the map uses,
so it stays a compact, local data source rather than making visitors fetch a third-party
file at page load.

Run from the repository root:

    python3 assets/data/build-marine-areas.py
"""

import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "marine-areas.json"
SOURCE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_50m_geography_marine_polys.geojson"
)
TYPES = {"ocean", "sea", "gulf", "bay", "strait", "channel", "sound"}


def main():
    with urllib.request.urlopen(SOURCE, timeout=60) as response:
        source = json.load(response)

    features = []
    for feature in source["features"]:
        props = feature["properties"]
        kind = props["featurecla"]
        if kind not in TYPES:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "name": props["name"],
                "type": kind,
                "rank": props["scalerank"],
            },
            "geometry": feature["geometry"],
        })

    features.sort(key=lambda feature: (feature["properties"]["rank"], feature["properties"]["name"]))
    OUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "source": "Natural Earth, 1:50m Marine Polygons (public domain)",
        "features": features,
    }, separators=(",", ":")) + "\n")
    print(f"{OUT.name}: {len(features)} named marine areas")


if __name__ == "__main__":
    main()
