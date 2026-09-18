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

// The Moon's phase at `date`: its elongation from the Sun (0° new, 90° first quarter, 180°
// full, 270° last quarter), the illuminated fraction of the disc that follows from it, and
// whether it's waxing (0°–180°, growing toward full) or waning (180°–360°, shrinking to new).
// The elongation is worth having on its own: it is also, give or take the libration, where the
// Sun stands over the Moon's own surface — see `MOON_SUBSOLAR_LON` in world-map.js, which is
// what decides which half of a drawn lunar globe is in daylight.
export function moonPhase(date) {
  const d = daysSinceJ2000(date);
  const sun = sunEcliptic(d);
  const moon = moonEcliptic(d, sun);
  const elongation = norm360(moon.lonEcl - sun.lon);
  return { elongation, illuminatedFraction: (1 - cosDeg(elongation)) / 2, waxing: elongation < 180 };
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

// ---------------------------------------------------------------------------------------------
// The planets. Same method, same epoch, same shape as the Sun and Moon above — Schlyter's
// orbital elements, solved for a position in the planet's own orbital plane, rotated into
// heliocentric ecliptic coordinates, and then shifted by the Sun's own position to become
// geocentric. Elements drift linearly with `d`, which is why each is a function of it.
const PLANETS = {
  mercury: { radiusKm: 2439.7, elements: (d) => ({
    N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.00e-8 * d, w: 29.1241 + 1.01444e-5 * d,
    a: 0.387098, e: 0.205635 + 5.59e-10 * d, M: 168.6562 + 4.0923344368 * d }) },
  venus: { radiusKm: 6051.8, elements: (d) => ({
    N: 76.6799 + 2.46590e-5 * d, i: 3.3946 + 2.75e-8 * d, w: 54.8910 + 1.38374e-5 * d,
    a: 0.723330, e: 0.006773 - 1.302e-9 * d, M: 48.0052 + 1.6021302244 * d }) },
  mars: { radiusKm: 3389.5, elements: (d) => ({
    N: 49.5574 + 2.11081e-5 * d, i: 1.8497 - 1.78e-8 * d, w: 286.5016 + 2.92961e-5 * d,
    a: 1.523688, e: 0.093405 + 2.516e-9 * d, M: 18.6021 + 0.5240207766 * d }) },
  jupiter: { radiusKm: 71492, elements: (d) => ({
    N: 100.4542 + 2.76854e-5 * d, i: 1.3030 - 1.557e-7 * d, w: 273.8777 + 1.64505e-5 * d,
    a: 5.20256, e: 0.048498 + 4.469e-9 * d, M: 19.8950 + 0.0830853001 * d }) },
  saturn: { radiusKm: 60268, elements: (d) => ({
    N: 113.6634 + 2.38980e-5 * d, i: 2.4886 - 1.081e-7 * d, w: 339.3939 + 2.97661e-5 * d,
    a: 9.55475, e: 0.055546 - 9.499e-9 * d, M: 316.9670 + 0.0334442282 * d }) },
  uranus: { radiusKm: 25559, elements: (d) => ({
    N: 74.0005 + 1.3978e-5 * d, i: 0.7733 + 1.9e-8 * d, w: 96.6612 + 3.0565e-5 * d,
    a: 19.18171 - 1.55e-8 * d, e: 0.047318 + 7.45e-9 * d, M: 142.5905 + 0.011725806 * d }) },
  neptune: { radiusKm: 24764, elements: (d) => ({
    N: 131.7806 + 3.0173e-5 * d, i: 1.7700 - 2.55e-7 * d, w: 272.8461 - 6.027e-6 * d,
    a: 30.05826 + 3.313e-8 * d, e: 0.008606 + 2.15e-9 * d, M: 260.2471 + 0.005995147 * d }) },
};
export const PLANET_NAMES = Object.keys(PLANETS);
export const planetRadiusKm = (name) => PLANETS[name].radiusKm;

// Heliocentric ecliptic longitude, latitude and distance, with the largest mutual perturbations
// applied. The giants pull each other around by enough to see: Jupiter and Saturn's 5:2
// near-resonance — the "great inequality", the term with `2·Mj − 5·Ms` in it — swings Saturn's
// longitude by up to 0.8°, which is more than twice the moon's own width. Left out, Saturn would
// sit visibly off its real place among the stars; the rest of Schlyter's terms are smaller than
// the sky's own drawn detail and are not worth carrying.
function planetHeliocentric(name, d) {
  const el = PLANETS[name].elements(d);
  const E = eccentricAnomaly(norm360(el.M), el.e);
  const xv = el.a * (Math.cos(E) - el.e);
  const yv = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  const v = Math.atan2(yv, xv) / DEG;
  const r = Math.hypot(xv, yv);
  const vw = v + el.w;
  const xh = r * (cosDeg(el.N) * cosDeg(vw) - sinDeg(el.N) * sinDeg(vw) * cosDeg(el.i));
  const yh = r * (sinDeg(el.N) * cosDeg(vw) + cosDeg(el.N) * sinDeg(vw) * cosDeg(el.i));
  const zh = r * (sinDeg(vw) * sinDeg(el.i));

  let lon = norm360(Math.atan2(yh, xh) / DEG);
  let lat = Math.atan2(zh, Math.hypot(xh, yh)) / DEG;
  const Mj = norm360(PLANETS.jupiter.elements(d).M);
  const Ms = norm360(PLANETS.saturn.elements(d).M);
  const Mu = norm360(PLANETS.uranus.elements(d).M);
  if (name === 'jupiter') {
    lon += -0.332 * sinDeg(2 * Mj - 5 * Ms - 67.6) - 0.056 * sinDeg(2 * Mj - 2 * Ms + 21)
      + 0.042 * sinDeg(3 * Mj - 5 * Ms + 21) - 0.036 * sinDeg(Mj - 2 * Ms)
      + 0.022 * cosDeg(Mj - Ms) + 0.023 * sinDeg(2 * Mj - 3 * Ms + 52) - 0.016 * sinDeg(Mj - 5 * Ms - 69);
  } else if (name === 'saturn') {
    lon += 0.812 * sinDeg(2 * Mj - 5 * Ms - 67.6) - 0.229 * cosDeg(2 * Mj - 4 * Ms - 2)
      + 0.119 * sinDeg(Mj - 2 * Ms - 3) + 0.046 * sinDeg(2 * Mj - 6 * Ms - 69)
      + 0.014 * sinDeg(Mj - 3 * Ms + 32);
    lat += -0.020 * cosDeg(2 * Mj - 4 * Ms - 2) + 0.018 * sinDeg(2 * Mj - 6 * Ms - 49);
  } else if (name === 'uranus') {
    lon += 0.040 * sinDeg(Ms - 2 * Mu + 6) + 0.035 * sinDeg(Ms - 3 * Mu + 33)
      - 0.015 * sinDeg(Mj - Mu + 20);
  }
  return { lon: norm360(lon), lat, r };
}

// The position angle, in degrees, of `toward` as seen from `from` — measured at `from` starting
// at celestial north and turning toward celestial east, which is the convention every catalogue
// and every observer's eyepiece uses. Two different things on the sky are found with it: which
// way a planet's lit edge faces (`toward` the Sun) and which way Saturn's rings are tipped
// (`toward` the north pole of the ring plane).
export function positionAngle(from, toward) {
  const dRa = toward.ra - from.ra;
  return norm360(Math.atan2(
    cosDeg(toward.dec) * sinDeg(dRa),
    sinDeg(toward.dec) * cosDeg(from.dec) - cosDeg(toward.dec) * sinDeg(from.dec) * cosDeg(dRa),
  ) / DEG);
}

// A planet's apparent place and appearance at `date`. Beyond position and size:
//   `illuminatedFraction` — the planets between us and the Sun show phases exactly as the moon
//     does, and Venus's are large enough that Galileo saw them through his first telescope; the
//     outer planets never turn more than a few degrees away from full.
//   `brightLimbAngle` — which way that lit edge points on the sky, so a drawn crescent leans
//     the right way instead of an arbitrary one.
export function planetEquatorial(name, date) {
  const d = daysSinceJ2000(date);
  const planet = planetHeliocentric(name, d);
  const sun = sunEcliptic(d);
  const xh = planet.r * cosDeg(planet.lon) * cosDeg(planet.lat);
  const yh = planet.r * sinDeg(planet.lon) * cosDeg(planet.lat);
  const zh = planet.r * sinDeg(planet.lat);
  const xg = xh + sun.r * cosDeg(sun.lon);
  const yg = yh + sun.r * sinDeg(sun.lon);
  const distance = Math.hypot(xg, yg, zh);
  const lon = norm360(Math.atan2(yg, xg) / DEG);
  const lat = Math.atan2(zh, Math.hypot(xg, yg)) / DEG;
  const place = eclipticToEquatorial(lon, lat, d);

  // The phase angle is the Sun–planet–Earth angle, straight out of the triangle whose three
  // sides are the planet's distance from the Sun, its distance from us, and ours from the Sun.
  const cosPhase = (planet.r * planet.r + distance * distance - sun.r * sun.r)
    / (2 * planet.r * distance);
  return {
    ...place,
    distance,
    heliocentricDistance: planet.r,
    eclipticLongitude: lon,
    eclipticLatitude: lat,
    semidiameter: angularRadius(PLANETS[name].radiusKm, distance * AU_KM),
    illuminatedFraction: (1 + Math.max(-1, Math.min(1, cosPhase))) / 2,
    brightLimbAngle: positionAngle(place, sunEquatorial(date)),
  };
}

// Saturn's rings, as they were presented to Earth at `date` — Meeus, ch. 45. `openingAngle` is
// the Saturnicentric latitude of the Earth: 0° when we are in the ring plane and they vanish
// into a line, ±27° when they are thrown widest open. `axisAngle` is the position angle of the
// ring plane's north pole, which is simply where that pole lies on the sky, asked the same way
// as everything else. The ring plane's own pole sits 90° from its node, at the co-inclination.
export function saturnRings(date) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525;
  const inclination = 28.075216 - 0.012998 * T + 0.000004 * T * T;
  const node = 169.508470 + 1.394681 * T + 0.000412 * T * T;
  const saturn = planetEquatorial('saturn', date);
  const openingAngle = Math.asin(
    sinDeg(inclination) * cosDeg(saturn.eclipticLatitude) * sinDeg(saturn.eclipticLongitude - node)
    - cosDeg(inclination) * sinDeg(saturn.eclipticLatitude),
  ) / DEG;
  const pole = eclipticToEquatorial(norm360(node - 90), 90 - inclination, daysSinceJ2000(date));
  return { openingAngle, axisAngle: positionAngle(saturn, pole) };
}

// Jupiter's rotation, as presented to Earth at `date` — Meeus, ch. 43. Jupiter is fluid and
// does not turn as one piece, so there are two clocks: System I for the fast equatorial belt
// between the two equatorial belts, System II for everything poleward of them, which is where
// the long-lived spots live. `cm2` is the System II longitude of the central meridian, and a
// feature of longitude λ is facing us when λ is near it. `latitudeOfEarth` is how far Jupiter's
// equator is tipped toward us, never more than about 3°, because its axis barely leans.
export function jupiterRotation(date) {
  const d = julianDate(date) - 2451545.0;
  const V = 172.74 + 0.00111588 * d;
  const M = 357.529 + 0.9856003 * d;
  const N = 20.020 + 0.0830853 * d + 0.329 * sinDeg(V);
  const J = 66.115 + 0.9025179 * d - 0.329 * sinDeg(V);
  const A = 1.915 * sinDeg(M) + 0.020 * sinDeg(2 * M);
  const B = 5.555 * sinDeg(N) + 0.168 * sinDeg(2 * N);
  const K = J + A - B;
  const R = 1.00014 - 0.01671 * cosDeg(M) - 0.00014 * cosDeg(2 * M);
  const r = 5.20872 - 0.25208 * cosDeg(N) - 0.00611 * cosDeg(2 * N);
  const delta = Math.sqrt(r * r + R * R - 2 * r * R * cosDeg(K));
  const psi = Math.asin((R / delta) * sinDeg(K)) / DEG;
  const lambda = 34.35 + 0.083091 * d + 0.329 * sinDeg(V) + B;
  const dS = 3.12 * sinDeg(lambda + 42.8);
  // Light takes about 43 minutes to cross from Jupiter, so the face we see left it Δ/173 days
  // ago: the correction is what makes a predicted transit time land on the observed one.
  const lit = d - delta / 173;
  return {
    cm1: norm360(210.98 + 877.8169088 * lit + psi - B),
    cm2: norm360(187.23 + 870.1869088 * lit + psi - B),
    latitudeOfEarth: dS - 2.22 * sinDeg(psi) * cosDeg(lambda + 22)
      - 1.30 * ((r - delta) / delta) * sinDeg(lambda - 100.5),
    distance: delta,
    psi,
    B,
  };
}

// The four moons Galileo saw in January 1610, in the positions they held at `date` — Meeus,
// ch. 44's short theory, good to a few tenths of a Jupiter radius, which is far finer than a
// drawn sky can show. `x` runs along Jupiter's equator (positive toward the west, the direction
// features drift as it turns) and `y` across it, both in Jupiter equatorial radii; `front` says
// whether the moon is on the near side of the planet or behind it. Their mean distances are
// 5.9, 9.4, 15.0 and 26.4 Jupiter radii, so at any real scale they are what makes Jupiter
// unmistakable long before its disc can be resolved — which is exactly how Galileo found them.
export const GALILEAN_MOONS = ['Io', 'Europa', 'Ganymede', 'Callisto'];
export function galileanMoons(date) {
  const jupiter = jupiterRotation(date);
  const d = julianDate(date) - 2451545.0;
  const lit = d - jupiter.distance / 173;
  const { psi, B } = jupiter;
  const u = [
    163.8067 + 203.4058643 * lit + psi - B,
    358.4108 + 101.2916334 * lit + psi - B,
    5.7129 + 50.2345179 * lit + psi - B,
    224.8151 + 21.4879801 * lit + psi - B,
  ];
  const G = 331.18 + 50.310482 * lit;
  const H = 87.45 + 21.569231 * lit;
  const correction = [
    0.473 * sinDeg(2 * (u[0] - u[1])),
    1.065 * sinDeg(2 * (u[1] - u[2])),
    0.165 * sinDeg(G),
    0.843 * sinDeg(H),
  ];
  const radius = [
    5.9057 - 0.0244 * cosDeg(2 * (u[0] - u[1])),
    9.3966 - 0.0882 * cosDeg(2 * (u[1] - u[2])),
    14.9883 - 0.0216 * cosDeg(G),
    26.3627 - 0.1939 * cosDeg(H),
  ];
  return GALILEAN_MOONS.map((name, i) => {
    const arg = norm360(u[i] + correction[i]);
    return {
      name,
      x: radius[i] * sinDeg(arg),
      y: -radius[i] * cosDeg(arg) * sinDeg(jupiter.latitudeOfEarth),
      front: cosDeg(arg) < 0, // in front of Jupiter rather than behind it
    };
  });
}
