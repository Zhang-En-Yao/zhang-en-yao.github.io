// The trip page: renders one travelogue, turns its photos into a gallery, and hands
// chat.js a companion for it. Depends on ui.js (`esc`, `fmtDate`, `emptyState`) and
// markdown.js (`renderMarkdown`, `decorateBody`).

const noteEl = document.getElementById('note');
const tocEl = document.getElementById('toc');
const id = new URLSearchParams(location.search).get('id');

const WORLD_SRC = 'assets/data/countries-50m.json';

// Each trip's photos live in their own public GitHub repo, served through jsDelivr's CDN.
// One repo per trip keeps any single repo from ever hitting GitHub's size limit, and the
// files sit at the root of each repo. By default the repo is `<PHOTO_REPO_OWNER>/<id>`
// on branch main — so a photo listed as "DSCF0683.jpeg" on trip 202606191345 is fetched from
//   https://cdn.jsdelivr.net/gh/ZhangEnYao/202606191345@main/DSCF0683.jpeg
// A trip whose repo is owned or named differently sets `photoRepo` on its index.json entry
// to an "owner/repo" slug (optionally "owner/repo@branch"), used in place of that default.
// A `photos` entry that is already a full http(s) URL is used verbatim, so a one-off photo
// can live anywhere.
const PHOTO_CDN = 'https://cdn.jsdelivr.net/gh';
const PHOTO_REPO_OWNER = 'ZhangEnYao';
const PHOTO_REPO_BRANCH = 'main';

// The repo photos are full-resolution camera JPEGs — ~6000px wide, ~1.7MB each — but the
// page shows them at a fraction of that: a thumbnail in the strip, a windowful in the
// lightbox. Downloading the original for either wastes ~100x the bytes. So the originals
// stay untouched in their repo and the page loads them through wsrv.nl, a free image proxy
// that resizes, re-compresses, and converts to WebP on the fly, then caches the result on
// its own CDN. `PHOTO_THUMB_W` feeds the strip; `PHOTO_FULL_W` the lightbox — a 900px WebP
// thumbnail is ~15KB against the original's 1.7MB. A `photos` entry that is already a full
// http(s) URL is passed through verbatim, unresized.
const PHOTO_PROXY = 'https://wsrv.nl/';
const PHOTO_THUMB_W = 900;
const PHOTO_FULL_W = 2000;

const SUGGESTIONS = [
  {
    label: 'Itinerary',
    short: 'How was this trip laid out?',
    detailed:
      'Lay this trip out day by day: where I went, in what order, and how long each part took.',
  },
  {
    label: 'Highlights',
    short: 'What was worth going to?',
    detailed:
      'Pick out the places this trip rates most highly, and say in one line each what made them worth the visit.',
  },
  {
    label: 'Logistics',
    short: 'Pull out the practical details.',
    detailed:
      'Collect every practical detail into a table: transport, where I stayed, what things cost, and anything worth booking ahead.',
  },
];

// The model gets the Markdown source, so a photo reaches it as `![alt](url)` — the alt
// text, and nothing else. It cannot see the image. Hence the note about captions.
function systemPrompt(meta, markdown) {
  return `You are a well-travelled companion helping a reader dig into a travelogue.

Places: ${tripTitle(meta)}
${meta.country ? `Country: ${meta.country}` : ''}
${tripDuration(meta) ? `When: ${fmtDuration(tripDuration(meta))}` : ''}
${flightsText(meta)}
Here is the full travelogue (Markdown):

<travelogue>
${markdown}
</travelogue>

Rules:
- Answer from the travelogue above. If it does not cover something, say so plainly, then add outside knowledge only if it helps — and label it as going beyond the travelogue.
- Photos appear as Markdown image links. You can read their captions, but you cannot see the images — never describe a photo as though you had looked at it.
- Reply in the language the reader writes in; default to English.
- Be concise and concrete. Quote the travelogue directly when it helps.`;
}

// The band under the title: where this trip happened, at the scale of the region rather
// than the country. Mercator, like the cards on the travel page — at one region's scale the
// job is to look like the shape you'd recognise, and a compromise projection buys nothing.
// The band's shape is load-bearing, not taste. fitExtent scales to whichever axis is
// tighter, so a long letterbox over a tall region is scaled by the latitude and then has
// its leftover width filled with whatever longitude reaches — which is how a trip to
// Britain ends up showing Poland. A squarer band spends that budget on the region instead.
const REGION_W = 800;
const REGION_H = 380;
const REGION_PAD = 16;

// How much sea and neighbouring land to leave around the cities. A trip is often one city,
// which has no extent to grow from, so the span has a floor: something has to decide how
// much of the world a single dot is worth.
const REGION_MARGIN = 2.1;
const MIN_SPAN_LON = 13; // degrees

// Framed on the cities, not on the country. `country` is a filing label — a week in Hong
// Kong is filed under China, and a map of China with one dot in the corner of it says
// nothing about where you went.
function regionBox(cities) {
  const lons = cities.map((c) => c.lon);
  const lats = cities.map((c) => c.lat);
  const [w, e] = [Math.min(...lons), Math.max(...lons)];
  const [s, n] = [Math.min(...lats), Math.max(...lats)];

  const spanLon = Math.max((e - w) * REGION_MARGIN, MIN_SPAN_LON);
  const spanLat = Math.max((n - s) * REGION_MARGIN, (MIN_SPAN_LON * REGION_H) / REGION_W);
  const [cx, cy] = [(w + e) / 2, (s + n) / 2];
  // A MultiPoint rather than a polygon of the box: a ring's orientation decides which side
  // of it d3 thinks is inside, and a box wound the wrong way measures the whole globe.
  // Four loose corners cannot be wound at all, and under Mercator — whose meridians and
  // parallels are both straight — the corners are the box exactly.
  return {
    type: 'MultiPoint',
    coordinates: [
      [cx - spanLon / 2, cy - spanLat / 2],
      [cx + spanLon / 2, cy - spanLat / 2],
      [cx - spanLon / 2, cy + spanLat / 2],
      [cx + spanLon / 2, cy + spanLat / 2],
    ],
  };
}

// The label's gap from its dot, the space one label needs to clear the next, and a rough
// px-per-character for 12px sans — enough to know whether two labels fight, which is all
// this needs, and it costs no layout pass to find out.
const LABEL_GAP = 11;
const LABEL_LINE = 15;
const LABEL_CHAR_W = 6.6;

// Places each city's dot, then moves the labels — never the dots — until nothing collides.
//
// Osaka and Kyoto are a third of a degree apart. No framing separates them, and none
// should: they really are that close, and the dots are the truth of the map. So the dots
// stay put and the labels move off them, on leader lines. Otherwise the closest pair of
// cities on a trip is exactly the pair whose names you cannot read.
//
// Labels dodge other cities' *dots* as well as their labels. A name is unreadable with a
// dot sitting in the middle of it, and the dot it collides with is never its own.
function layoutCities(cities, projection) {
  const placed = cities
    .map((c) => {
      const p = projection([c.lon, c.lat]);
      if (!p) return null;
      // A label near the right edge would run off it, so it changes sides instead.
      const flip = p[0] > REGION_W * 0.7;
      return {
        name: c.name,
        x: p[0],
        y: p[1],
        labelX: flip ? p[0] - LABEL_GAP : p[0] + LABEL_GAP,
        labelY: p[1],
        flip,
        width: c.name.length * LABEL_CHAR_W,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y); // Top down, so each label only has to clear the ones above.

  const box = (c) => (c.flip
    ? [c.labelX - c.width, c.labelX]
    : [c.labelX, c.labelX + c.width]);
  const hits = (c, x0, x1, y) => {
    const [b0, b1] = box(c);
    return Math.abs(c.labelY - y) < LABEL_LINE && b0 < x1 && x0 < b1;
  };

  placed.forEach((c, i) => {
    // Stack clear of the labels already placed above.
    for (const prev of placed.slice(0, i)) {
      const [a0, a1] = box(prev);
      if (hits(c, a0, a1, prev.labelY)) c.labelY = prev.labelY + LABEL_LINE;
    }
    c.labelY = Math.min(c.labelY, REGION_H - 8); // Never off the bottom of the band.

    // Then slide clear of anyone else's dot that ended up inside the name.
    for (const other of placed) {
      if (other === c) continue;
      if (!hits(c, other.x - 5, other.x + 5, other.y)) continue;
      c.labelX = c.flip ? Math.min(c.labelX, other.x - LABEL_GAP) : Math.max(c.labelX, other.x + LABEL_GAP);
    }
  });

  return placed;
}

function regionMapHtml(meta, features) {
  const cities = (meta.cities || []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  if (!features.length || !cities.length) return '';

  const projection = d3
    .geoMercator()
    .fitExtent([[REGION_PAD, REGION_PAD], [REGION_W - REGION_PAD, REGION_H - REGION_PAD]], regionBox(cities));
  // Everything outside the band is cut here rather than drawn and overflowed: without it
  // Mercator hands back a path for every country on earth, and the far ones run to
  // coordinates in the millions.
  projection.clipExtent([[0, 0], [REGION_W, REGION_H]]);
  const path = d3.geoPath(projection);

  const land = features
    .map((f) => {
      const d = path(f);
      if (!d) return ''; // Clipped away entirely: not in this part of the world.
      const cls = f.properties.name === meta.country ? 'region-country is-here' : 'region-country';
      return `<path class="${cls}" d="${d}"/>`;
    })
    .join('');

  // Two layers, not one group per city: every label has to sit above every dot, and in a
  // tight cluster the dot that would cover a name belongs to the city drawn after it.
  const placed = layoutCities(cities, projection);
  const dots = placed
    .map((c) => `<circle class="region-city-dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4"/>`)
    .join('');
  const labels = placed
    .map((c) => {
      // Pushed off its dot, the label needs to say which dot it belongs to.
      const moved = Math.abs(c.labelY - c.y) > 1 || Math.abs(c.labelX - c.x) > LABEL_GAP + 1;
      const leader = moved
        ? `<line class="region-city-leader" x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}"
                 x2="${c.labelX.toFixed(1)}" y2="${c.labelY.toFixed(1)}"/>`
        : '';
      return `
        <g class="region-city${c.flip ? ' is-flipped' : ''}">
          ${leader}
          <text class="region-city-label" x="${c.labelX.toFixed(1)}" y="${c.labelY.toFixed(1)}">${esc(c.name)}</text>
        </g>`;
    })
    .join('');

  // aria-hidden, and deliberately: every name on it is in the heading and the prose below,
  // so to a screen reader this band is decoration that would otherwise be read twice.
  return `
    <svg class="region-map" viewBox="0 0 ${REGION_W} ${REGION_H}" aria-hidden="true">
      <g class="region-land">${land}</g>
      <g class="region-dots">${dots}</g>
      <g class="region-labels">${labels}</g>
    </svg>`;
}

function headerHtml(meta, features) {
  const where = [meta.country, meta.continent].filter(Boolean).join(' · ');
  const mapHtml = regionMapHtml(meta, features);
  return `
    <div class="trip-header">
      <h1>${esc(tripTitle(meta))}</h1>
      ${where ? `<p class="venue">${esc(where)}</p>` : ''}
      ${tripDuration(meta) ? `<p class="publish-date">${esc(fmtDuration(tripDuration(meta)))}</p>` : ''}
      <div class="tags">${(meta.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
    ${mapHtml ? `<div class="trip-map">${mapHtml}</div>` : ''}
    ${flightsHtml(meta)}`;
}

// ---------- the flights ----------
//
// A flight is its legs in order, and a transfer is only the seam between two of them —
// there is no separate thing to model. Every time is local to its own airport, which is
// what the boarding pass prints and the one form the reader can check against one, so
// nothing here converts a time into anywhere else's clock.
//
// Which is also why no leg shows how long it took. That needs a timezone for both of its
// airports, and this file has neither — it has a code and a city name. A layover is the
// one duration that survives: both of its clocks belong to the same airport, so the
// subtraction is real elapsed time without knowing which zone they are in.

// "2025/12/28 18:30" — the trip's own `/` date, then a 24-hour clock. The time is
// optional, and a leg with only a date shows only a date rather than an invented 00:00.
function splitStamp(stamp) {
  const [date = '', time = ''] = String(stamp || '').trim().split(/\s+/);
  return { date, time };
}

// `tripDuration` and `flightsDuration` live in ui.js — the travel page frames its cards on
// the same dates, so the derivation is shared rather than owned by this page.

// Minutes since an arbitrary epoch — a number to subtract another one from, meaningless
// alone. Through Date.UTC so the arithmetic cannot pick up the reader's own timezone or
// its summer time; null when there is no full stamp to measure.
function stampMinutes(stamp) {
  const { date, time } = splitStamp(stamp);
  const [y, m, d] = date.split('/').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
}

function fmtGap(mins) {
  if (!Number.isFinite(mins) || mins < 0) return '';
  const [h, m] = [Math.floor(mins / 60), mins % 60];
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Whole days between two stamps' dates. Every time on a card is badged against the card's
// own date, the way a ticket badges an overnight arrival "+1" — and for the same reason:
// a transfer that sits over midnight leaves the next leg boarding at 01:55 on a day the
// card never names, and a bare "01:55" under a heading reading June 14 is a lie.
function dayShift(from, to) {
  const day = (stamp) => {
    const [y, m, d] = splitStamp(stamp).date.split('/').map(Number);
    return [y, m, d].every(Number.isFinite) ? Date.UTC(y, m - 1, d) / 86400000 : null;
  };
  const [a, b] = [day(from), day(to)];
  return a == null || b == null ? 0 : b - a;
}

// Rotated onto its side: the icon points north-east as drawn, and this line runs east.
const PLANE_ICON =
  '<svg class="leg-plane" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>';

// The code is the headline; the city name rides up into the card's head as the route
// ("Taipei to Osaka"), so an end here is just its code, its time, and — when a leg crosses
// midnight — the day it lands on. Given only a city and no code, the city is the headline.
// The full date rides its own line under the time, carried on every end, so a red-eye that
// lands the next morning shows that day plainly, and the two ends' times share a baseline.
function endHtml(place, stamp, cls) {
  const code = place.code || place.city || '';
  const { date, time } = splitStamp(stamp);
  const dateText = date ? fmtPart(date) : '';
  return `
    <div class="leg-end ${cls}">
      <span class="leg-code">${esc(code)}</span>
      <span class="leg-time">${esc(time)}</span>
      ${dateText ? `<span class="leg-day">${esc(dateText)}</span>` : ''}
    </div>`;
}

function legHtml(leg, origin) {
  const carrier = [leg.airline, leg.number].filter(Boolean).join(' ');
  return `
    <li class="flight-leg">
      ${endHtml(leg.from, leg.depart, 'is-depart')}
      <div class="leg-path">
        <span class="leg-line">${PLANE_ICON}</span>
        ${carrier ? `<p class="leg-carrier">${esc(carrier)}</p>` : ''}
      </div>
      ${endHtml(leg.to, leg.arrive, 'is-arrive')}
    </li>`;
}

function layoverHtml(leg, next) {
  if (!next) return '';
  const [a, b] = [stampMinutes(leg.arrive), stampMinutes(next.depart)];
  const gap = a == null || b == null ? '' : fmtGap(b - a);

  // Landing at one airport and leaving from another is a different afternoon from waiting
  // at a gate, and the two codes are the only place that difference shows.
  const moved = leg.to.code && next.from.code && leg.to.code !== next.from.code;
  const at = moved
    ? `changing airport, ${leg.to.code} → ${next.from.code}`
    : (next.from.city || next.from.code || '') && `in ${next.from.city || next.from.code}`;

  return `<li class="flight-layover">${esc([gap, at].filter(Boolean).join(' ') || 'Transfer')}</li>`;
}

function flightHtml(flight) {
  const legs = (flight.legs || []).filter((l) => l && l.from && l.to);
  if (!legs.length) return '';

  const origin = legs[0].depart;
  const rows = legs.flatMap((leg, i) => [legHtml(leg, origin), layoverHtml(leg, legs[i + 1])]);

  // The journey as its endpoints, city to city — the first leg's origin to the last leg's
  // destination, so a trip through a transfer still reads as where it began and where it
  // ended. This is the head's headline; the direction label sits beside it, quietened.
  const ends = [legs[0].from, legs[legs.length - 1].to].map((p) => p.city || p.code || '');
  const route = ends.every(Boolean) ? `${ends[0]} - ${ends[1]}` : '';
  const head = route ? `
    <p class="flight-head">
      ${route ? `<span class="flight-route">${esc(route)}</span>` : ''}
    </p>` : '';

  return `
    <div class="flight">
      ${head}
      <ol class="flight-legs">${rows.filter(Boolean).join('')}</ol>
    </div>`;
}

// The same flights for the model, which gets the travelogue but not the page. The prose
// rarely says which airport at what hour, and "Logistics" is one of the three things a
// reader asks this chat — so the itinerary goes in rather than being reconstructed from a
// sentence about a long night in a terminal. The timezone caveat is spelled out: without
// it the model will happily subtract two local clocks and report a nine-hour flight.
function flightsText(meta) {
  const lines = (meta.flights || []).flatMap((f) =>
    (f.legs || [])
      .filter((l) => l && l.from && l.to)
      .map((l) => {
        const carrier = [l.airline, l.number].filter(Boolean).join(' ');
        const end = (p, stamp) => `${p.code || p.city || '?'}${p.city && p.code ? ` (${p.city})` : ''} ${stamp || ''}`.trim();
        return `- ${end(l.from, l.depart)} → ${end(l.to, l.arrive)}${carrier ? ` on ${carrier}` : ''}`;
      }));
  if (!lines.length) return '';
  return `\nFlights (each time is local to that airport, so never subtract one from another to get a duration):\n${lines.join('\n')}\n`;
}

function flightsHtml(meta) {
  const flights = (meta.flights || []).map(flightHtml).filter(Boolean);
  if (!flights.length) return '';
  return `
    <section class="flights" aria-label="Flights">
      ${flights.join('<br />')}
    </section>`;
}

// A run of images becomes one of two things. By default each photo stands on its own down
// the page as a captioned figure. Wrap the run in `<div class="photo-strip">` in the
// Markdown — a plain element with a class, which marked passes straight through — and it
// becomes one horizontal filmstrip that scrolls instead. A photo with a sentence beside it
// is prose, and is left exactly as written.
//
// (The images inside a `<div class="photo-strip">` need a blank line before and after them,
// or marked treats the whole block as raw HTML and never parses them into images.)
function buildGalleries(bodyEl) {
  const photos = [];

  // One <img> → a button the lightbox can open, registered in `photos` in document order.
  // The grid cell keeps the small thumbnail `src`; the lightbox gets the larger `data-full`
  // when one is set (repo photos), falling back to the same src for plain markdown images.
  const cellFor = (img) => {
    const i = photos.push({ src: img.dataset.full || img.src, alt: img.alt }) - 1;
    return `
        <button class="photo" type="button" data-photo="${i}" aria-label="${esc(img.alt || 'Open photo')}">
          <img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">
        </button>`;
  };

  // `.photo-strip` wrappers and bare image paragraphs in one document-ordered pass, so the
  // lightbox steps through every photo in the order it appears. Replacing a strip whole
  // detaches the <p> marked nested inside it, so that <p> is skipped when the loop reaches it.
  bodyEl.querySelectorAll('.photo-strip, p').forEach((el) => {
    if (!bodyEl.contains(el)) return; // Already consumed as part of a strip above.

    if (el.classList.contains('photo-strip')) {
      const imgs = [...el.querySelectorAll('img')];
      if (!imgs.length) return;

      // The filmstrip: captions would outweigh the pictures here, so they live in the
      // lightbox instead. Each photo's real aspect ratio sets its width against the shared
      // row height — the markdown only gave a src, so the ratio is read off the image once
      // it has loaded and written back as `--ar`; until then the CSS fallback (1.5) holds.
      const box = document.createElement('div');
      box.className = 'photo-grid';
      box.innerHTML = imgs.map(cellFor).join('');
      el.replaceWith(box);

      box.querySelectorAll('.photo').forEach((btn) => {
        const im = btn.querySelector('img');
        // Each cell holds a skeleton until its thumbnail arrives; loading it also reports the
        // true ratio, so both are cleared in one pass. `is-loading` is set before first paint.
        const done = () => {
          if (im.naturalWidth && im.naturalHeight) {
            btn.style.setProperty('--ar', (im.naturalWidth / im.naturalHeight).toFixed(4));
          }
          btn.classList.remove('is-loading');
        };
        btn.classList.add('is-loading');
        if (im.complete) done();
        else {
          im.addEventListener('load', done, { once: true });
          im.addEventListener('error', () => btn.classList.remove('is-loading'), { once: true });
        }
      });
      return;
    }

    // A bare paragraph of images and nothing else: each photo stacks down the page as its
    // own captioned figure.
    const imgs = [...el.children].filter((c) => c.tagName === 'IMG');
    if (!imgs.length || imgs.length !== el.children.length) return;
    if (el.textContent.trim()) return;

    const frag = document.createDocumentFragment();
    imgs.forEach((img) => {
      const fig = document.createElement('figure');
      fig.className = 'photo-figure';
      fig.innerHTML = cellFor(img) + (img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : '');
      frag.appendChild(fig);
    });
    el.replaceWith(frag);
  });

  return photos;
}

// The trip's own photos, declared in index.json instead of the travelogue: a `photos` array
// on the trip's entry, each item a filename served from the root of that trip's photo repo
// (or an object with `file` and optional `alt`, or a full http(s) URL to override the
// repo). They render as one filmstrip at the foot of the note by building the same
// `<div class="photo-strip">` the Markdown hack used to spell out by hand, then letting
// buildGalleries turn it into a grid — so the lightbox and aspect-ratio fitting come for
// free and there is no marked quirk.
function photoUrl(file, meta) {
  if (/^https?:\/\//.test(file)) return file; // A full URL is used as written.
  // `photoRepo` overrides the id-named default, and may pin a branch with "…@branch".
  const slug = meta.photoRepo || `${PHOTO_REPO_OWNER}/${meta.id}`;
  const [repo, branch = PHOTO_REPO_BRANCH] = slug.split('@');
  return `${PHOTO_CDN}/${repo}@${branch}/${encodeURIComponent(file)}`;
}

// A repo photo routed through the resize proxy at a target width, as WebP. The proxy caches
// per distinct URL, so the same width is fetched once and served from its CDN thereafter.
function sizedUrl(url, width, quality) {
  const params = new URLSearchParams({ url, w: String(width), q: String(quality), output: 'webp' });
  return `${PHOTO_PROXY}?${params.toString()}`;
}

function appendPhotoStrip(bodyEl, meta) {
  const names = meta.photos || [];
  if (!names.length) return;

  const strip = document.createElement('div');
  strip.className = 'photo-strip';
  strip.innerHTML = names
    .map((p) => {
      const file = typeof p === 'string' ? p : p.file;
      if (!file) return '';
      const alt = typeof p === 'string' ? file.replace(/\.[^.]+$/, '') : (p.alt || '');
      const raw = photoUrl(file, meta);
      // A one-off full URL is left as written; a repo photo is loaded small for the strip,
      // with the larger lightbox size carried on `data-full` for buildGalleries to pick up.
      if (/^https?:\/\//.test(file)) return `<img src="${esc(raw)}" alt="${esc(alt)}">`;
      const thumb = sizedUrl(raw, PHOTO_THUMB_W, 75);
      const full = sizedUrl(raw, PHOTO_FULL_W, 80);
      return `<img src="${esc(thumb)}" data-full="${esc(full)}" alt="${esc(alt)}">`;
    })
    .join('');
  bodyEl.appendChild(strip);
}

function initLightbox(bodyEl, photos) {
  if (!photos.length) return;

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `
    <button class="lightbox-btn lightbox-close" type="button" data-close aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    <button class="lightbox-btn lightbox-prev" type="button" data-step="-1" aria-label="Previous photo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
    </button>
    <figure class="lightbox-figure">
      <img class="lightbox-img" alt="">
      <figcaption class="lightbox-caption"></figcaption>
    </figure>
    <button class="lightbox-btn lightbox-next" type="button" data-step="1" aria-label="Next photo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    </button>`;
  document.body.appendChild(box);

  const imgEl = box.querySelector('.lightbox-img');
  const capEl = box.querySelector('.lightbox-caption');
  const closeEl = box.querySelector('[data-close]');
  const stepEls = [...box.querySelectorAll('[data-step]')];

  let at = 0;
  let opener = null; // Where focus came from, and where it has to go back to.

  function show(i) {
    at = (i + photos.length) % photos.length; // Wraps, so the arrows never dead-end.
    capEl.textContent = photos[at].alt || '';
    capEl.hidden = !photos[at].alt;
    imgEl.alt = photos[at].alt;
    imgEl.src = photos[at].src;
  }

  function open(i, from) {
    opener = from;
    show(i);
    box.hidden = false;
    document.body.classList.add('is-locked');
    closeEl.focus();
  }

  function close() {
    box.hidden = true;
    document.body.classList.remove('is-locked');
    opener?.focus();
    opener = null;
  }

  // A single photo has nowhere to step to.
  stepEls.forEach((el) => { el.hidden = photos.length < 2; });

  bodyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-photo]');
    if (btn) open(Number(btn.dataset.photo), btn);
  });

  box.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) return show(at + Number(step.dataset.step));
    // The backdrop is the dialog itself; a click that lands on the photo is not a miss.
    if (e.target.closest('[data-close]') || !e.target.closest('.lightbox-figure')) close();
  });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && photos.length > 1) show(at - 1);
    else if (e.key === 'ArrowRight' && photos.length > 1) show(at + 1);
  });
}

if (!id) {
  noteEl.innerHTML = emptyState({
    icon: 'file',
    title: 'No trip specified',
    description: 'This page needs an <code>?id=</code> parameter to know which trip to open.',
    actions: '<a class="btn" href="travel.html">Back to the map</a>',
  });
} else {
  Promise.all([
    fetch('travel/index.json').then((r) => r.json()),
    // The band under the title is the one thing on this page that is decoration. If the
    // atlas will not load, the trip still reads — so this failure resolves to no map
    // rather than joining the rejection below and taking the travelogue with it.
    fetch(WORLD_SRC)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ])
    .then(([trips, world]) => {
      const meta = trips.find((t) => t.id === id);
      if (!meta) throw new Error('not found');

      const features = world ? topojson.feature(world, world.objects.countries).features : [];
      document.title = `${tripTitle(meta)} — Travels`;

      // An entry with no `file` is a place and a date on the map and nothing more —
      // it has been logged, not written up. Show what there is rather than 404ing,
      // and leave the chat out of it: there is no travelogue to ground it in.
      if (!meta.file) {
        noteEl.innerHTML = headerHtml(meta, features) + emptyState({
          icon: 'file',
          title: 'Not written up yet',
          description: 'This trip is on the map, but there is no travelogue for it.',
          actions: '<a class="btn" href="travel.html">Back to the map</a>',
        });
        return;
      }

      return fetch(`travel/${meta.file}`)
        .then((r) => {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        })
        .then((md) => {
          noteEl.innerHTML = `${headerHtml(meta, features)}<div class="note-body">${renderMarkdown(md)}</div>`;

          const bodyEl = noteEl.querySelector('.note-body');
          decorateBody(bodyEl, tocEl);
          appendPhotoStrip(bodyEl, meta);
          initLightbox(bodyEl, buildGalleries(bodyEl));

          document.dispatchEvent(new CustomEvent('chat:init', {
            detail: {
              title: 'Ask this trip',
              subtitle: 'Model · grounded in this travelogue',
              placeholder: 'Ask about this trip…',
              intro: 'Ask me anything about this trip.',
              system: systemPrompt(meta, md),
              suggestions: SUGGESTIONS,
            },
          }));
        });
    })
    .catch(() => {
      noteEl.innerHTML = emptyState({
        icon: 'search',
        title: 'Trip not found',
        description: `No trip matches <code>${esc(id)}</code>, or its file could not be fetched. ${SERVE_HINT}`,
        actions: '<a class="btn" href="travel.html">Back to the map</a>',
      });
    });
}
