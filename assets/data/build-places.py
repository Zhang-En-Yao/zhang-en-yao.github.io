#!/usr/bin/env python3
"""Regenerate places.json — the Wikidata record behind every point in every travelogue.

Each point in travel/<id>.json is matched to a Wikidata item, which gives it a verified
coordinate and the history the fact card shows: founding date, religion, architectural
style, architect, heritage status and UNESCO World Heritage listing, plus Wikipedia links.

Matching is name search (wbsearchentities) crossed with proximity to the coordinate
already in the file; anything the two do not agree on lands in OVERRIDES below, by hand.
A point mapped to None has no Wikidata item and is left alone.

Writes:
  assets/data/places.json  entities, World Heritage sites, and the point index places.html reads
  travel/<id>.json         a "wikidata" key on each point, and its coordinate snapped to
                           Wikidata when the two are within SNAP_M

Run from the repo root. Needs the network (Wikidata's API and query service):

    python3 assets/data/build-places.py            # matched points only
    python3 assets/data/build-places.py --review   # also print what needs a human
"""

import argparse
import json
import math
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
TRAVEL = HERE.parent.parent / "travel"
OUT = HERE / "places.json"

API = "https://www.wikidata.org/w/api.php"
SPARQL = "https://query.wikidata.org/sparql"
AGENT = "zhang-en-yao.github.io places builder (build-places.py)"
GAP_S = 0.15

MAG_NAME_MIN = 0.55  # name similarity a search hit needs before it is accepted
MAX_M = 1200         # …and how far it may sit from the coordinate already on file
SNAP_M = 150         # a match this close replaces the hand-typed coordinate
SNAP_AREA_M = 400    # …or this close, for a district, island, street or other area

# Points the automatic match gets wrong or cannot find. None = not in Wikidata.
OVERRIDES = {
    "Former Temiya Line": "Q7698128",
    "Otaru Snow Light Path": "Q11462179",
    "Sakaimachi Street": None,          # Otaru's; Q11428316 is Kyoto's, 1000 km away
    "Kitaichi Glass": "Q11400834",
    "Asahikawa Ramen Village": "Q11087091",
    "Ken and Mary Tree": "Q17990887",
    "Seven Star Tree": None,
    "Christmas Tree Tree": None,
    "Takushinkan": "Q30066271",
    "Hōkan-ji (Yasaka Pagoda)": "Q11555353",
    "Togetsukyō Bridge": "Q11561923",
    "Kouri Bridge": "Q24834962",
    "Shuri Castle Park": "Q907052",     # the castle, which carries the history
    "Pino's Place": None,
    "Minatogawa Foreign Housing District": None,
    "Blue Seal Makiminato Honten": None,
    "teamLab Future Park Okinawa": None,
    "Nguyễn Văn Bình Book Street": None,
    "Tân Định Church": "Q7682043",
    "The Café Apartment": None,
    "Phạm Ngũ Lão and Bùi Viện": "Q3033670",
    "Coi Saigon": None,
    "Bạch Đằng Wharf": "Q32226383",
    "Vĩnh Tràng Pagoda": "Q7932540",
    "Mỹ Tho and the Four Islands": "Q33425",
    "Thới Sơn Island": "Q16480765",
    "Tân Thạch": "Q10830864",
    "Barrio de Las Letras": "Q5721097",
    "Mirador del Valle": None,
    "Gonzar": None,                     # several Gonzars in Galicia; none within 13 km
    "Santiago de Compostela Old Town": "Q12386144",
    "Museu d'Història de Barcelona, Plaça del Rei / Barcino": "Q3571337",
    "La Llotja de Mar": "Q4895858",
    "La Pedrera / Casa Milà": "Q207870",
    "Sant Pau Recinte Modernista": "Q507282",
    "Olympic Ring": "Q4761637",
}

# Instance-of values whose coordinate is a centroid, so a wider gap is normal.
AREA_TYPES = {
    "Q123705", "Q75135432", "Q790344", "Q3321844", "Q23442", "Q8502", "Q22698", "Q22746",
    "Q79007", "Q207934", "Q29518746", "Q12284", "Q44782", "Q721207", "Q2276925",
    "Q20541692", "Q121289819", "Q3249005", "Q2389082", "Q676050", "Q1050303", "Q272888",
    "Q5327369", "Q738570", "Q1497375", "Q2073106", "Q866623", "Q66364404", "Q1200957",
    "Q15835", "Q357685", "Q2637759", "Q1851368",
}

# Claims worth showing, and how many values to keep of each.
CLAIMS = [
    ("type", "P31", 2), ("style", "P149", 3), ("religion", "P140", 2),
    ("architect", "P84", 3), ("founder", "P112", 2), ("heritage", "P1435", 3),
]
DATES = [("inception", "P571"), ("opened", "P1619"), ("ended", "P576")]
WIKIS = ["zh", "en", "ja", "es", "ca", "vi", "gl"]
ZH = '"zh-tw","zh-hant","zh"'  # in preference order; the first hit for an item wins


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except OSError as error:
            if attempt == 3:
                raise
            print(f"  retrying ({error})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def sparql(query):
    time.sleep(GAP_S)
    return get(f"{SPARQL}?format=json&query={urllib.parse.quote(query)}")["results"]["bindings"]


def search(name):
    time.sleep(GAP_S)
    url = (f"{API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item"
           f"&limit=12&search={urllib.parse.quote(name)}")
    return [(h["id"], h.get("label", ""), h.get("aliases") or []) for h in get(url).get("search", [])]


def haversine(lat1, lon1, lat2, lon2):
    r, d = 6371000.0, math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2
         + math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lon2 - lon1) * d / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def similarity(a, b):
    norm = lambda s: re.sub(r"[^a-z0-9　-鿿]+", " ", s.lower()).strip()
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    x, y = set(a.split()), set(b.split())
    jaccard = len(x & y) / len(x | y)
    return max(jaccard, 0.75 if a in b or b in a else 0.0)


def variants(name):
    out = [name]
    paren = re.match(r"^(.*?)\s*\((.*?)\)\s*$", name)
    if paren:
        out += [paren.group(1), paren.group(2)]
    out += re.split(r"\s*[/,]\s*", name)
    return [v.strip() for v in dict.fromkeys(out) if len(v.strip()) > 2]


def coords_of(qids):
    out = {}
    for i in range(0, len(qids), 200):
        values = " ".join("wd:" + q for q in qids[i:i + 200])
        rows = sparql(f"SELECT ?item ?c WHERE {{ VALUES ?item {{ {values} }} ?item wdt:P625 ?c . }}")
        for row in rows:
            m = re.search(r"Point\(([-\d.]+) ([-\d.]+)\)", row["c"]["value"])
            if m:
                out[row["item"]["value"].rsplit("/", 1)[-1]] = (float(m.group(2)), float(m.group(1)))
    return out


def resolve(point):
    """The best Wikidata item for a point, or None."""
    hits = []
    for name in variants(point["name"]):
        hits += search(name)
        if hits and name == point["name"]:
            break
    hits = list({h[0]: h for h in hits}.values())
    if not hits:
        return None
    coords = coords_of([h[0] for h in hits])
    best, best_score = None, 0.0
    for qid, label, aliases in hits:
        xy = coords.get(qid)
        if not xy:
            continue
        distance = haversine(point["lat"], point["lon"], *xy)
        name_score = max([similarity(v, label) for v in variants(point["name"])]
                         + [similarity(point["name"], a) for a in aliases])
        if name_score < MAG_NAME_MIN or distance > MAX_M:
            continue
        score = name_score * 0.7 + math.exp(-distance / 250) * 0.3
        if score > best_score:
            best, best_score = qid, score
    return best


def pack(rows, key, limit):
    """Claim values as "QID~English~Chinese", deduplicated, at most `limit` of them."""
    seen = {}
    for row in rows:
        qid = row[key]["value"].rsplit("/", 1)[-1]
        en = row.get("en", {}).get("value", "")
        zh = row.get("zh", {}).get("value", "")
        if qid not in seen or (zh and not seen[qid][1]):
            seen[qid] = (en, zh)
    out = []
    for qid, (en, zh) in list(seen.items())[:limit]:
        out.append("~".join([qid, en, zh if zh != en else ""]).rstrip("~"))
    return out


def pull(qids, prop, limit):
    out = {}
    for i in range(0, len(qids), 120):
        values = " ".join("wd:" + q for q in qids[i:i + 120])
        rows = sparql(f"""SELECT ?item ?v ?en ?zh WHERE {{ VALUES ?item {{ {values} }}
          ?item wdt:{prop} ?v .
          OPTIONAL {{ ?v rdfs:label ?en FILTER(LANG(?en) = "en") }}
          OPTIONAL {{ ?v rdfs:label ?zh FILTER(LANG(?zh) IN ({ZH})) }} }}""")
        for row in rows:
            out.setdefault(row["item"]["value"].rsplit("/", 1)[-1], []).append(row)
    return {q: pack(rows, "v", limit) for q, rows in out.items()}


def pull_dates(qids, prop):
    out = {}
    for i in range(0, len(qids), 200):
        values = " ".join("wd:" + q for q in qids[i:i + 200])
        rows = sparql(f"SELECT ?item ?v WHERE {{ VALUES ?item {{ {values} }} ?item wdt:{prop} ?v . }}")
        for row in rows:
            stamp = row["v"]["value"]
            if not re.match(r"^-?\d{3,4}-\d{2}-\d{2}T", stamp):
                continue  # "unknown value" nodes come back as a hash
            sign, digits = ("-", stamp[1:]) if stamp[0] == "-" else ("", stamp)
            year = sign + str(int(digits.split("-")[0]))
            out.setdefault(row["item"]["value"].rsplit("/", 1)[-1], [])
            if year not in out[row["item"]["value"].rsplit("/", 1)[-1]]:
                out[row["item"]["value"].rsplit("/", 1)[-1]].append(year)
    return out


def load_points():
    """Every point in every travelogue, with the trip and section it sits in."""
    points = []
    for trip in json.loads((TRAVEL / "index.json").read_text()):
        path = TRAVEL / f"{trip['id']}.json"
        if not path.exists():
            continue
        doc = json.loads(path.read_text())
        for section in doc.get("sections", []):
            for sub in section.get("subsections", []):
                for point in sub.get("points", []):
                    points.append(dict(point, trip=trip["id"], where=sub.get("heading"),
                                       title=doc.get("title") or trip["id"]))
            for point in section.get("points", []):
                points.append(dict(point, trip=trip["id"], where=section.get("heading"),
                                   title=doc.get("title") or trip["id"]))
    return points


def write_back(points):
    """Add "wikidata" and the snapped coordinate to the trip files, as a text edit so the
    rest of each file keeps its hand-made formatting."""
    number = lambda v: repr(round(v, 6)).rstrip("0").rstrip(".")
    for trip in {p["trip"] for p in points}:
        path = TRAVEL / f"{trip}.json"
        raw, at, moved = path.read_text(), 0, 0
        for point in [p for p in points if p["trip"] == trip]:
            name = json.dumps(point["name"], ensure_ascii=False)
            pattern = re.compile(
                r'( *)"name": ' + re.escape(name) + r',\n(?P<mid>(?: *"kind": .*\n)?)'
                r' *"lat": (?P<lat>[-\d.]+),\n *"lon": (?P<lon>[-\d.]+),\n'
                r'(?: *"wikidata": ".*",\n)?')
            m = pattern.search(raw, at)
            if not m:
                print(f"  ! {trip}: could not find {point['name']} in the file")
                continue
            indent = m.group(1)
            lat, lon = point.get("snap") or (point["lat"], point["lon"])
            if (float(m.group("lat")), float(m.group("lon"))) != (lat, lon):
                moved += 1
            block = f'{indent}"name": {name},\n{m.group("mid")}'
            block += f'{indent}"lat": {number(lat)},\n{indent}"lon": {number(lon)},\n'
            if point.get("qid"):
                block += f'{indent}"wikidata": "{point["qid"]}",\n'
            raw = raw[:m.start()] + block + raw[m.end():]
            at = m.start() + len(block)
        json.loads(raw)
        path.write_text(raw)
        print(f"{trip}: {moved} coordinates moved")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--review", action="store_true", help="list what a human still has to settle")
    args = parser.parse_args()

    points = load_points()
    print(f"{len(points)} points")
    for point in points:
        if point["name"] in OVERRIDES:
            point["qid"] = OVERRIDES[point["name"]]
        else:
            point["qid"] = resolve(point)
            print(f"  {point['name']}: {point['qid'] or 'no match'}")

    qids = sorted({p["qid"] for p in points if p["qid"]})
    print(f"{len(qids)} entities")

    places = {q: {} for q in qids}
    rows = []
    for i in range(0, len(qids), 120):
        values = " ".join("wd:" + q for q in qids[i:i + 120])
        rows += sparql(f"""SELECT ?item ?c ?en ?zh ?enD ?zhD WHERE {{ VALUES ?item {{ {values} }}
          OPTIONAL {{ ?item wdt:P625 ?c }}
          OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
          OPTIONAL {{ ?item rdfs:label ?zh FILTER(LANG(?zh) IN ({ZH})) }}
          OPTIONAL {{ ?item schema:description ?enD FILTER(LANG(?enD) = "en") }}
          OPTIONAL {{ ?item schema:description ?zhD FILTER(LANG(?zhD) IN ({ZH})) }} }}""")
    for row in rows:
        place = places[row["item"]["value"].rsplit("/", 1)[-1]]
        if "c" in row and "c" not in place:
            m = re.search(r"Point\(([-\d.]+) ([-\d.]+)\)", row["c"]["value"])
            if m:
                place["c"] = [round(float(m.group(2)), 6), round(float(m.group(1)), 6)]
        for key, field in (("en", "en"), ("zh", "zh"), ("enD", "_ed"), ("zhD", "_zd")):
            if key in row and field not in place:
                place[field] = row[key]["value"]
    for place in places.values():
        desc = place.pop("_zd", None) or place.pop("_ed", None)
        place.pop("_ed", None)
        if desc:
            place["desc"] = desc

    for key, prop, limit in CLAIMS:
        for qid, values in pull(qids, prop, limit).items():
            values = [v for v in values if not v.startswith(("Q43113623~", "Q9259~"))]
            if values:
                places[qid][key] = values
        print(f"  {key}: {sum(1 for p in places.values() if key in p)}")
    for key, prop in DATES:
        for qid, years in pull_dates(qids, prop).items():
            places[qid][key] = years

    # World Heritage: the item's own listing, or the one it is a part of.
    whs, sites = {}, {}
    for i in range(0, len(qids), 150):
        values = " ".join("wd:" + q for q in qids[i:i + 150])
        for row in sparql(f"""SELECT ?item ?whs ?id WHERE {{ VALUES ?item {{ {values} }}
          {{ ?item wdt:P757 ?id . BIND(?item AS ?whs) }} UNION {{ ?item wdt:P361 ?whs . ?whs wdt:P757 ?id }}
          UNION {{ ?item wdt:P361/wdt:P361 ?whs . ?whs wdt:P757 ?id }} }}"""):
            qid = row["item"]["value"].rsplit("/", 1)[-1]
            whs[qid] = f'{row["whs"]["value"].rsplit("/", 1)[-1]}~{row["id"]["value"]}'
    for qid, packed in whs.items():
        places[qid]["whs"] = packed
    if whs:
        values = " ".join("wd:" + w.split("~")[0] for w in set(whs.values()))
        for row in sparql(f"""SELECT ?whs ?en ?zh ?crit ?critLabel ?year WHERE {{ VALUES ?whs {{ {values} }}
          OPTIONAL {{ ?whs rdfs:label ?en FILTER(LANG(?en) = "en") }}
          OPTIONAL {{ ?whs rdfs:label ?zh FILTER(LANG(?zh) IN ({ZH})) }}
          OPTIONAL {{ ?whs wdt:P2614 ?crit }}
          OPTIONAL {{ ?whs p:P1435 [ ps:P1435 wd:Q9259 ; pq:P580 ?year ] }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" }} }}"""):
            site = sites.setdefault(row["whs"]["value"].rsplit("/", 1)[-1], {"crit": []})
            for key, field in (("en", "en"), ("zh", "zh")):
                if key in row and field not in site:
                    site[field] = row[key]["value"]
            if "year" in row:
                site["year"] = row["year"]["value"][:4]
            if "critLabel" in row and row["critLabel"]["value"] not in site["crit"]:
                site["crit"].append(row["critLabel"]["value"])

    # Snap the coordinates the match agrees with; leave the rest for review.
    review = []
    for point in points:
        place = places.get(point["qid"])
        if not place:
            review.append((point, None, "no entity"))
            continue
        if "c" not in place:
            review.append((point, None, "no coordinate"))
            continue
        distance = haversine(point["lat"], point["lon"], *place["c"])
        area = any(v.split("~")[0] in AREA_TYPES for v in place.get("type", []))
        if distance <= (SNAP_AREA_M if area else SNAP_M):
            point["snap"] = place["c"]
        else:
            review.append((point, round(distance), "area" if area else "point"))

    index = [{"t": p["trip"], "n": p["name"], "s": p["where"], "q": p["qid"]}
             for p in points if p["qid"]]
    titles = {p["trip"]: p["title"] for p in points}
    OUT.write_text(json.dumps({"places": places, "whs": sites, "points": index, "trips": titles},
                              ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f'{OUT.name}: {len(places)} entities, {len(index)} points, '
          f'{OUT.stat().st_size / 1024:.0f} KB')
    write_back(points)

    if args.review:
        print(f"\n{len(review)} to settle by hand:")
        for point, distance, why in sorted(review, key=lambda r: (r[2], -(r[1] or 0))):
            gap = f"{distance:5d} m" if distance else ""
            print(f'  {why:13} {point["trip"]} {point["name"][:44]:46} {gap}')


if __name__ == "__main__":
    main()
