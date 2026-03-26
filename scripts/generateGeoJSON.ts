import fs from "fs";
import path from "path";
import {
  type FlightWithTrack,
  type FlightHistory,
  type Airport,
} from "./types.js";

// ── Paths ──────────────────────────────────────────────────────────────────────
const ROOT = path.join(new URL(import.meta.url).pathname, "../..");
const HISTORY_PATH = path.join(ROOT, "data/flight-history.json");
const AIRPORTS_CSV_PATH = path.join(ROOT, "data/airports.csv");
const RUNWAYS_CSV_PATH = path.join(ROOT, "data/runways.csv");
const GEOJSON_PATH = path.join(ROOT, "public/flightmap.geojson");

// ── CSV Parsing ────────────────────────────────────────────────────────────────
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function loadAirports(): { airports: Map<string, Airport>; icaoToIata: Map<string, string> } {
  const csv = fs.readFileSync(AIRPORTS_CSV_PATH, "utf-8");
  const lines = csv.split("\n");
  const airports = new Map<string, Airport>();
  const icaoToIata = new Map<string, string>();

  const parsed: ReturnType<typeof parseCSVLine>[] = [];
  // First pass: load all airports with an IATA code
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    parsed.push(fields);
    const iata = fields[13]?.trim();
    if (!iata) continue;
    const icao = fields[1]?.trim();
    if (icao) icaoToIata.set(icao, iata);
    const lat = parseFloat(fields[4]);
    const lng = parseFloat(fields[5]);
    if (isNaN(lat) || isNaN(lng)) continue;
    airports.set(iata, {
      iata,
      name: fields[3] ?? "",
      lat,
      lng,
      country: fields[8] ?? "",
    });
  }

  // Second pass: recover IATA codes for closed airports from keywords
  for (const fields of parsed) {
    if (fields[13]?.trim() || fields[2]?.trim() !== "closed") continue;
    const keywords = fields[18]?.trim();
    if (!keywords) continue;
    const codes = keywords.split(",").map((k) => k.trim()).filter((k) => /^[A-Z]{3}$/.test(k));
    const match = codes.find((c) => !airports.has(c));
    if (!match) continue;
    const icao = fields[1]?.trim();
    if (icao) icaoToIata.set(icao, match);
    const lat = parseFloat(fields[4]);
    const lng = parseFloat(fields[5]);
    if (isNaN(lat) || isNaN(lng)) continue;
    airports.set(match, {
      iata: match,
      name: fields[3] ?? "",
      lat,
      lng,
      country: fields[8] ?? "",
    });
  }

  console.log(`Loaded ${airports.size} airports`);
  return { airports, icaoToIata };
}

// ── Synthetic track generation ──────────────────────────────────────────────────

/** Convert degrees to radians */
const toRad = (d: number) => (d * Math.PI) / 180;
/** Convert radians to degrees */
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Compute the initial bearing (forward azimuth) from point A to point B
 * on the sphere. Returns degrees [0, 360).
 */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Compute a destination point given start, bearing (degrees) and distance (km).
 */
function destinationPoint(lat: number, lon: number, brng: number, distKm: number): [number, number] {
  const R = 6371;
  const δ = distKm / R;
  const θ = toRad(brng);
  const φ1 = toRad(lat), λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(λ2), toDeg(φ2)]; // [lon, lat]
}

/**
 * Haversine distance in km between two points.
 */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Interpolate along a great circle between two points.
 * fraction ∈ [0, 1].  Returns [lon, lat].
 */
function greatCircleInterpolate(
  lat1: number, lon1: number, lat2: number, lon2: number, fraction: number
): [number, number] {
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
  ));
  if (d < 1e-10) return [lon1, lat1];
  const A = Math.sin((1 - fraction) * d) / Math.sin(d);
  const B = Math.sin(fraction * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))];
}

/**
 * Load runway headings from OurAirports runways.csv.
 * Returns a map from IATA code to an array of unique runway headings (degrees true).
 */
function loadRunwayHeadings(icaoToIata: Map<string, string>): Map<string, number[]> {
  const headings = new Map<string, Set<number>>();

  if (!fs.existsSync(RUNWAYS_CSV_PATH)) {
    console.log("⚠ No runways.csv found – synthetic tracks will use great-circle headings only.");
    return new Map();
  }

  const csv = fs.readFileSync(RUNWAYS_CSV_PATH, "utf-8");
  const lines = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    const icao = fields[2]?.trim();
    const closed = fields[7]?.trim();
    if (!icao || closed === "1") continue;
    const iata = icaoToIata.get(icao);
    if (!iata) continue;

    const leHdg = parseFloat(fields[12]);
    const heHdg = parseFloat(fields[18]);
    if (!headings.has(iata)) headings.set(iata, new Set());
    const set = headings.get(iata)!;
    if (!isNaN(leHdg)) set.add(Math.round(leHdg));
    if (!isNaN(heHdg)) set.add(Math.round(heHdg));
  }

  const result = new Map<string, number[]>();
  for (const [iata, set] of headings) {
    result.set(iata, [...set]);
  }
  console.log(`Loaded runway headings for ${result.size} airports`);
  return result;
}

/**
 * Pick the runway heading that best matches an inbound or outbound course.
 * For arrivals, we want the heading closest to the inbound course (plane lands INTO wind/runway).
 * For departures, we want the heading closest to the outbound course.
 */
function pickRunwayHeading(headings: number[], courseDeg: number): number {
  let best = headings[0];
  let bestDiff = 180;
  for (const h of headings) {
    let diff = Math.abs(h - courseDeg);
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = h;
    }
  }
  return best;
}

/**
 * Generate a synthetic flight track between two airports.
 *
 * Strategy:
 * 1. Compute a great-circle path with ~64 intermediate points for the cruise portion.
 * 2. For the departure: generate a short straight segment along the runway heading,
 *    then smoothly turn onto the great-circle course.
 * 3. For the arrival: smoothly turn from the great-circle course onto the runway heading
 *    for the final approach.
 *
 * If no runway headings are known for an airport, we just use the great-circle course
 * (still much better than a 2-point straight line).
 */
function generateSyntheticTrack(
  fromAirport: Airport,
  toAirport: Airport,
  runwayHeadings: Map<string, number[]>
): [number, number][] {
  const totalDist = haversineKm(fromAirport.lat, fromAirport.lng, toAirport.lat, toAirport.lng);

  // For very short flights (< 50 km), just do a simple great circle
  if (totalDist < 50) {
    const points: [number, number][] = [];
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      points.push(greatCircleInterpolate(
        fromAirport.lat, fromAirport.lng, toAirport.lat, toAirport.lng, i / steps
      ));
    }
    return points;
  }

  // Departure & arrival turn segment length: 30-80 km depending on total distance
  const turnDist = Math.min(80, Math.max(30, totalDist * 0.08));

  // ── Departure segment ────────────────────────────────────────────────────
  const gcBearingOut = bearing(fromAirport.lat, fromAirport.lng, toAirport.lat, toAirport.lng);
  const depHeadings = runwayHeadings.get(fromAirport.iata);
  const depRunwayHdg = depHeadings ? pickRunwayHeading(depHeadings, gcBearingOut) : gcBearingOut;

  // Generate the departure turn: start on runway heading, smoothly blend to GC heading
  const depPoints: [number, number][] = [];
  const depSteps = 8;
  for (let i = 1; i <= depSteps; i++) {
    const t = i / depSteps;
    // Smoothstep easing for natural-looking turn
    const s = t * t * (3 - 2 * t);
    // Blend heading from runway to great-circle
    let hdgDiff = gcBearingOut - depRunwayHdg;
    if (hdgDiff > 180) hdgDiff -= 360;
    if (hdgDiff < -180) hdgDiff += 360;
    const currentHdg = depRunwayHdg + hdgDiff * s;
    const dist = turnDist * t;
    depPoints.push(destinationPoint(fromAirport.lat, fromAirport.lng, currentHdg, dist));
  }

  // ── Arrival segment ──────────────────────────────────────────────────────
  const gcBearingIn = bearing(toAirport.lat, toAirport.lng, fromAirport.lat, fromAirport.lng);
  const arrHeadings = runwayHeadings.get(toAirport.iata);
  // For arrival, the runway heading is the direction the plane faces on landing,
  // which is the OPPOSITE of the direction from which it comes
  const arrRunwayHdg = arrHeadings
    ? pickRunwayHeading(arrHeadings, (gcBearingIn + 180) % 360)
    : (gcBearingIn + 180) % 360;
  // Reverse heading: the direction the plane flies FROM (opposite of landing heading)
  const arrApproachFrom = (arrRunwayHdg + 180) % 360;

  const arrPoints: [number, number][] = [];
  const arrSteps = 8;
  for (let i = arrSteps; i >= 1; i--) {
    const t = i / arrSteps;
    const s = t * t * (3 - 2 * t);
    let hdgDiff = gcBearingIn - arrApproachFrom;
    if (hdgDiff > 180) hdgDiff -= 360;
    if (hdgDiff < -180) hdgDiff += 360;
    const currentHdg = arrApproachFrom + hdgDiff * s;
    // Build outward from airport: t=1 is farthest (great-circle), t→0 is closest (runway)
    const dist = turnDist * t;
    arrPoints.push(destinationPoint(toAirport.lat, toAirport.lng, currentHdg, dist));
  }

  // ── Cruise (great circle) segment ────────────────────────────────────────
  // Compute the start/end points of the cruise as fraction of total great-circle distance
  const cruiseStartFrac = Math.min(0.15, turnDist / totalDist);
  const cruiseEndFrac = 1 - cruiseStartFrac;
  const cruiseSteps = Math.max(10, Math.min(50, Math.round(totalDist / 50)));
  const cruisePoints: [number, number][] = [];
  for (let i = 0; i <= cruiseSteps; i++) {
    const frac = cruiseStartFrac + (cruiseEndFrac - cruiseStartFrac) * (i / cruiseSteps);
    cruisePoints.push(greatCircleInterpolate(
      fromAirport.lat, fromAirport.lng, toAirport.lat, toAirport.lng, frac
    ));
  }

  return [...depPoints, ...cruisePoints, ...arrPoints];
}

// ── GeoJSON helpers ────────────────────────────────────────────────────────────
function airportFeature(airport: Airport, flightCount: number) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: [airport.lng, airport.lat],
    },
    properties: {
      featureType: "airport",
      iata: airport.iata,
      name: airport.name,
      country: airport.country,
      flightCount,
    },
  };
}

function routeFeature(
  flight: FlightWithTrack,
  coordinates: [number, number][]
) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates,
    },
    properties: {
      featureType: "route",
      date: flight.date,
      flightNumber: flight.flightNumber,
      from: flight.from,
      to: flight.to,
      distance: flight.distance,
      departureTime: flight.departureTime,
      arrivalTime: flight.arrivalTime,
      airline: flight.airline,
      aircraft: flight.aircraft,
      registration: flight.registration,
      trackSource: flight.trackSource,
    },
  };
}

// ── Main Pipeline ──────────────────────────────────────────────────────────────
function main() {
  const { airports, icaoToIata } = loadAirports();
  const runwayHeadings = loadRunwayHeadings(icaoToIata);

  if (!fs.existsSync(HISTORY_PATH)) {
    console.log("No flight-history.json found. Run sync-history first.");
    return;
  }

  const history: FlightHistory = JSON.parse(
    fs.readFileSync(HISTORY_PATH, "utf-8")
  );
  console.log(`Loaded ${history.flights.length} flights from history`);

  // Count flights per airport and collect used airports
  // Only count an airport if both endpoints of the flight are known,
  // so we don't emit orphan dots with no connecting route
  const airportFlightCount = new Map<string, number>();
  const missingAirports = new Set<string>();

  for (const flight of history.flights) {
    const fromKnown = flight.from ? airports.has(flight.from) : false;
    const toKnown = flight.to ? airports.has(flight.to) : false;

    if (!fromKnown && flight.from) missingAirports.add(flight.from);
    if (!toKnown && flight.to) missingAirports.add(flight.to);

    if (fromKnown && toKnown) {
      airportFlightCount.set(flight.from, (airportFlightCount.get(flight.from) ?? 0) + 1);
      airportFlightCount.set(flight.to, (airportFlightCount.get(flight.to) ?? 0) + 1);
    }
  }

  if (missingAirports.size > 0) {
    console.log(`⚠ Missing airports in CSV: ${[...missingAirports].join(", ")}`);
  }

  // Build airport point features
  const airportFeatures = [...airportFlightCount.entries()].map(([iata, count]) =>
    airportFeature(airports.get(iata)!, count)
  );

  // Build route line features
  let trackedCount = 0;
  let greatCircleCount = 0;
  let skippedCount = 0;

  const routeFeatures = history.flights
    .map((flight) => {
      const fromAirport = flight.from ? airports.get(flight.from) : undefined;
      const toAirport = flight.to ? airports.get(flight.to) : undefined;

      if (!fromAirport || !toAirport) {
        skippedCount++;
        return null;
      }

      let coordinates: [number, number][];

      if (flight.track && flight.track.length > 0) {
        // Anchor track to airport coordinates so lines connect to airport dots
        coordinates = [
          [fromAirport.lng, fromAirport.lat],
          ...flight.track,
          [toAirport.lng, toAirport.lat],
        ];
        trackedCount++;
      } else {
        // Generate a synthetic flight path with runway-aligned departure/arrival
        coordinates = [
          [fromAirport.lng, fromAirport.lat],
          ...generateSyntheticTrack(fromAirport, toAirport, runwayHeadings),
          [toAirport.lng, toAirport.lat],
        ];
        greatCircleCount++;
      }

      return routeFeature(flight, coordinates);
    })
    .filter((f) => f !== null);

  const geojson = {
    type: "FeatureCollection",
    features: [...airportFeatures, ...routeFeatures],
  };

  fs.mkdirSync(path.dirname(GEOJSON_PATH), { recursive: true });
  fs.writeFileSync(GEOJSON_PATH, JSON.stringify(geojson));

  const sizeKB = Math.round(fs.statSync(GEOJSON_PATH).size / 1024);
  console.log(`\n=== Done ===`);
  console.log(`Airports: ${airportFeatures.length}`);
  console.log(`Routes: ${routeFeatures.length} (Tracked: ${trackedCount}, Generated: ${greatCircleCount}, Skipped: ${skippedCount})`);
  console.log(`Written ${GEOJSON_PATH} (${sizeKB} KB)`);
}

main();
