// Low-precision (arcminute-ish) geocentric Sun/Moon ephemeris, plus Greenwich sidereal time —
// Paul Schlyter's compact orbital-element method (https://stjarnhimlen.se/comp/ppcomp.html) for
// the Sun and Moon, and the standard IAU-82 polynomial for GMST. Good enough to place the moon
// at its true position and phase for a given moment; not concerned with topocentric parallax,
// nutation, or atmospheric refraction — none of which matter at the scale of a decorative globe.

const DEG = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const sinDeg = (deg) => Math.sin(deg * DEG);
const cosDeg = (deg) => Math.cos(deg * DEG);

// Mean Earth–Moon distance, in Earth radii — the semi-major axis Schlyter's elements are fit
// to. `moonEquatorial`'s `distance` divided against this gives how much bigger or smaller the
// Moon should look at a given moment than "average" (real perigee-to-apogee swing: ~±6%).
export const MOON_MEAN_DISTANCE = 60.2666;

// Julian Date from a JS `Date` (interpreted in UTC, as every `Date` timestamp is).
function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// "Days since 2000 Jan 0.0 UT" — the epoch Schlyter's orbital elements are fit to.
function daysSinceJ2000(date) {
  return julianDate(date) - 2451543.5;
}

// Greenwich Mean Sidereal Time, in degrees — the standard IAU-82 polynomial.
export function gmstDegrees(date) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525.0;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T - (T * T * T) / 38710000;
  return norm360(gmst);
}

// Solves Kepler's equation M = E - e·sin(E) (radians) for the eccentric anomaly E, by Newton's
// method — a handful of iterations is exact to double precision for these small eccentricities.
function eccentricAnomaly(meanAnomalyDeg, e) {
  const M = meanAnomalyDeg * DEG;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

// Sun's geocentric ecliptic longitude (and the mean elements Moon's perturbation terms need).
function sunEcliptic(d) {
  const w = norm360(282.9404 + 4.70935e-5 * d); // argument of perihelion
  const e = 0.016709 - 1.151e-9 * d; // eccentricity
  const M = norm360(356.0470 + 0.9856002585 * d); // mean anomaly
  const E = eccentricAnomaly(M, e);
  const xv = Math.cos(E) - e;
  const yv = Math.sqrt(1 - e * e) * Math.sin(E);
  const lon = norm360(Math.atan2(yv, xv) / DEG + w);
  return { lon, M, w };
}

// Moon's geocentric ecliptic longitude/latitude, corrected by the Sun's main perturbations
// (evection, variation, the yearly equation, and a handful more) — Schlyter's low-precision set.
function moonEcliptic(d, sun) {
  const N = norm360(125.1228 - 0.0529538083 * d); // longitude of ascending node
  const i = 5.1454; // inclination
  const w = norm360(318.0634 + 0.1643573223 * d); // argument of perigee
  const a = 60.2666; // mean distance, Earth radii
  const e = 0.054900; // eccentricity
  const M = norm360(115.3654 + 13.0649929509 * d); // mean anomaly

  const E = eccentricAnomaly(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(E));
  const v = Math.atan2(yv, xv) / DEG;
  const r = Math.hypot(xv, yv);

  const vw = v + w;
  const xh = r * (cosDeg(N) * cosDeg(vw) - sinDeg(N) * sinDeg(vw) * cosDeg(i));
  const yh = r * (sinDeg(N) * cosDeg(vw) + cosDeg(N) * sinDeg(vw) * cosDeg(i));
  const zh = r * (sinDeg(vw) * sinDeg(i));

  let lonEcl = norm360(Math.atan2(yh, xh) / DEG);
  let latEcl = Math.atan2(zh, Math.hypot(xh, yh)) / DEG;

  const Ms = sun.M;
  const Mm = M;
  const Ls = norm360(sun.w + sun.M);
  const Lm = norm360(N + w + M);
  const D = norm360(Lm - Ls); // mean elongation from the Sun
  const F = norm360(Lm - N); // argument of latitude

  lonEcl += -1.274 * sinDeg(Mm - 2 * D) + 0.658 * sinDeg(2 * D) - 0.186 * sinDeg(Ms)
    - 0.059 * sinDeg(2 * Mm - 2 * D) - 0.057 * sinDeg(Mm - 2 * D + Ms) + 0.053 * sinDeg(Mm + 2 * D)
    + 0.046 * sinDeg(2 * D - Ms) + 0.041 * sinDeg(Mm - Ms) - 0.035 * sinDeg(D)
    - 0.031 * sinDeg(Mm + Ms) - 0.015 * sinDeg(2 * F - 2 * D) + 0.011 * sinDeg(Mm - 4 * D);

  latEcl += -0.173 * sinDeg(F - 2 * D) - 0.055 * sinDeg(Mm - F - 2 * D)
    - 0.046 * sinDeg(Mm + F - 2 * D) + 0.033 * sinDeg(F + 2 * D) + 0.017 * sinDeg(2 * Mm + F);

  const distance = r - 0.58 * cosDeg(Mm - 2 * D) - 0.46 * cosDeg(2 * D); // Earth radii

  return { lonEcl: norm360(lonEcl), latEcl, distance };
}

// Rotates an ecliptic direction about the vernal equinox by the obliquity, to equatorial (RA/Dec).
function eclipticToEquatorial(lonEcl, latEcl, d) {
  const obliquity = 23.4393 - 3.563e-7 * d;
  const xe = cosDeg(lonEcl) * cosDeg(latEcl);
  const ye = sinDeg(lonEcl) * cosDeg(latEcl) * cosDeg(obliquity) - sinDeg(latEcl) * sinDeg(obliquity);
  const ze = sinDeg(lonEcl) * cosDeg(latEcl) * sinDeg(obliquity) + sinDeg(latEcl) * cosDeg(obliquity);
  return { ra: norm360(Math.atan2(ye, xe) / DEG), dec: Math.atan2(ze, Math.hypot(xe, ye)) / DEG };
}

// The Moon's true (apparent) geocentric equatorial position at `date`, plus its distance
// (Earth radii — compare against `MOON_MEAN_DISTANCE` for how much bigger/smaller than
// average it should appear).
export function moonEquatorial(date) {
  const d = daysSinceJ2000(date);
  const sun = sunEcliptic(d);
  const moon = moonEcliptic(d, sun);
  return { ...eclipticToEquatorial(moon.lonEcl, moon.latEcl, d), distance: moon.distance };
}

// The Moon's phase at `date`: illuminated fraction of the disc (0 = new, 1 = full) and whether
// it's waxing (elongation 0°–180°, growing toward full) or waning (180°–360°, shrinking to new).
export function moonPhase(date) {
  const d = daysSinceJ2000(date);
  const sun = sunEcliptic(d);
  const moon = moonEcliptic(d, sun);
  const elongation = norm360(moon.lonEcl - sun.lon);
  return { illuminatedFraction: (1 - cosDeg(elongation)) / 2, waxing: elongation < 180 };
}
