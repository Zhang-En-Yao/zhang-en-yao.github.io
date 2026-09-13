// Every URL that leaves this repository, in one file.
//
// The site is the framework; the data lives in asset repositories and arrives over jsDelivr.
// Two kinds:
//
//   assets.core            the atlas and the sky — one pin for the whole site
//   assets.trip.<id>       one per trip: its content, places, streets and photos
//
// Both are pinned to a tag, never to a branch. jsDelivr caches a tag forever and a branch
// for an unpredictable few hours, so `@main` means the live page and your local clone can
// disagree with no way to tell which is which. Moving a pin is the only way data reaches
// the site, which makes it the place to stop and look.

const CDN = 'https://cdn.jsdelivr.net/gh';

export const CORE = `${CDN}/Zhang-En-Yao/assets.core@2026-09-13`;

// A trip's base URL, or null when it has no `assets` pin in travel/index.json — that trip
// is still served from this repository. Both paths work at once, so trips move one at a
// time and an unmigrated one is never broken by a migrated one.
export function tripAssets(trip) {
  const pin = trip && trip.assets;
  if (!pin) return null;
  return `${CDN}/${pin}`; // "owner/repo@tag", exactly as the workflow summary prints it
}
