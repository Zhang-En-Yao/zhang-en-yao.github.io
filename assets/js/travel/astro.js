// Low-precision (arcminute-ish) geocentric Sun/Moon ephemeris, plus Greenwich sidereal time —
// Paul Schlyter's compact orbital-element method (https://stjarnhimlen.se/comp/ppcomp.html) for
// the Sun and Moon, and the standard IAU-82 polynomial for GMST. Good enough to place the moon
// at its true position and phase for a given moment; not concerned with topocentric parallax,
// nutation, or atmospheric refraction — none of which matter at the scale of a decorative globe.

const DEG = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const sinDeg = (deg) => Math.sin(deg * DEG);
const cosDeg = (deg) => Math.cos(deg * DEG);

// The radii and distances the apparent sizes below are worked out from. The two body radii are
// exported because how big the Sun and Moon *look* depends on where you stand, and callers may
// want to stand somewhere other than Earth.
export const SUN_RADIUS_KM = 695700;
export const MOON_RADIUS_KM = 1737.4;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6378.14; // equatorial, the unit Schlyter's lunar distance comes in

// The angular radius, in degrees, that a sphere of radius `bodyRadiusKm` covers when seen from
// `distanceKm` away from its centre. Exact rather than the small-angle `r/d`, because the point
// of having it separately is to be able to ask it from close up, where the two diverge. The
// `semidiameter` each ephemeris below reports is this same function answered from Earth — a
// caller that wants the view from somewhere else (as the travel map does, standing where two
// spacecraft stood) asks it again with a distance of its own.
export function angularRadius(bodyRadiusKm, distanceKm) {
  return Math.asin(Math.min(1, bodyRadiusKm / distanceKm)) / DEG;
}

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
  return { lon, M, w, r: Math.hypot(xv, yv) }; // r in AU: 0.983 at perihelion, 1.017 at aphelion
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

// The Sun's true geocentric equatorial position at `date`, its distance in AU, and the
// `semidiameter` (angular radius, in degrees) that distance puts it at — about 0.262° at
// aphelion and 0.271° at perihelion. Its ecliptic latitude is 0 by definition (the ecliptic
// is the plane of Earth's orbit around the Sun, so the Sun itself never has latitude in
// that frame). Geocentric, not topocentric: an observer on the surface sees the Sun a
// hundredth of a percent smaller, which is nobody's problem.
export function sunEquatorial(date) {
  const d = daysSinceJ2000(date);
  const sun = sunEcliptic(d);
  return {
    ...eclipticToEquatorial(sun.lon, 0, d),
    distance: sun.r,
    semidiameter: angularRadius(SUN_RADIUS_KM, sun.r * AU_KM),
  };
}

// The Moon's true (apparent) geocentric equatorial position at `date`, its distance in Earth
// radii, and the `semidiameter` that distance puts it at. The Moon's orbit is eccentric enough
// that this really moves: about 0.249° at apogee and 0.279° at perigee, a ±6% swing, which is
// why it is worth deriving a drawn size from rather than fixing one. Compare it against the
// Sun's on the same date and the near-coincidence that makes total eclipses possible — the two
// discs within a few percent of each other — falls out on its own.
export function moonEquatorial(date) {
  const d = daysSinceJ2000(date);
  const sun = sunEcliptic(d);
  const moon = moonEcliptic(d, sun);
  return {
    ...eclipticToEquatorial(moon.lonEcl, moon.latEcl, d),
    distance: moon.distance,
    semidiameter: angularRadius(MOON_RADIUS_KM, moon.distance * EARTH_RADIUS_KM),
  };
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

// The Sun's rotation axis, as seen from Earth at `date` — Meeus, *Astronomical Algorithms*,
// ch. 29 ("Ephemeris for Physical Observations of the Sun"). Three angles orient the solar
// disc, and without them a plotted sunspot lands in the wrong place:
//   `p`  position angle of the solar north pole, measured eastward from the celestial north
//        point — the Sun's axis leans by up to ±26° over a year, so the whole disc is tilted.
//   `b0` heliographic latitude of the disc's centre: the Sun's equator is inclined 7.25° to
//        the ecliptic, so we look down on the north pole for half the year and up at it for
//        the other half (early September is close to the +7.25° extreme).
//   `l0` Carrington longitude of the disc's centre, which winds backwards through 360° every
//        27.2753 days. A spot's Carrington longitude is fixed to the rotating Sun, so its
//        distance from the central meridian at any moment is just `lon - l0`.
// Checked against the Debrecen observatory's own reported values for the plate this map's
// sunspots come from (1994 Sep 9, 06:05:02 UT: P = 22.92°, B0 = 7.25°, L0 = 48.88°) and
// against Meeus's own worked example 29.a — both match to within 0.03°.
export function sunPhysicalEphemeris(date) {
  const jd = julianDate(date);
  const d = daysSinceJ2000(date);
  const theta = norm360((jd - 2398220) * 360 / 25.38); // Carrington's sidereal rotation clock
  const K = 73.6667 + 1.3958333 * (jd - 2396758) / 36525; // ecliptic longitude of the solar equator's ascending node
  const I = 7.25; // inclination of the solar equator to the ecliptic
  const lambda = norm360(sunEcliptic(d).lon - 0.00569); // apparent longitude: geometric, less aberration
  const obliquity = 23.4393 - 3.563e-7 * d;
  const x = Math.atan(-cosDeg(lambda) * Math.tan(obliquity * DEG)) / DEG; // tilt from the ecliptic's own lean
  const y = Math.atan(-cosDeg(lambda - K) * Math.tan(I * DEG)) / DEG; // tilt from the solar axis itself
  const eta = Math.atan2(-sinDeg(lambda - K) * cosDeg(I), -cosDeg(lambda - K)) / DEG;
  return {
    p: x + y,
    b0: Math.asin(sinDeg(lambda - K) * sinDeg(I)) / DEG,
    l0: norm360(eta - theta),
  };
}
