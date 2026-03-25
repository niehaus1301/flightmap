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
const GEOJSON_PATH = path.join(ROOT, "generated/flightmap.geojson");

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

function loadAirports(): Map<string, Airport> {
  const csv = fs.readFileSync(AIRPORTS_CSV_PATH, "utf-8");
  const lines = csv.split("\n");
  const airports = new Map<string, Airport>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    const iata = fields[13]?.trim();
    if (!iata) continue;
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

  console.log(`Loaded ${airports.size} airports`);
  return airports;
}

// ── Great Circle Arc ───────────────────────────────────────────────────────────
function greatCircleArc(
  from: [number, number],
  to: [number, number],
  steps = 50
): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const lat1 = toRad(from[1]),
    lng1 = toRad(from[0]);
  const lat2 = toRad(to[1]),
    lng2 = toRad(to[0]);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
      )
    );

  if (d < 1e-10) return [from, to];

  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    points.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return points;
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
  const airports = loadAirports();

  if (!fs.existsSync(HISTORY_PATH)) {
    console.log("No flight-history.json found. Run sync-history first.");
    return;
  }

  const history: FlightHistory = JSON.parse(
    fs.readFileSync(HISTORY_PATH, "utf-8")
  );
  console.log(`Loaded ${history.flights.length} flights from history`);

  // Count flights per airport and collect used airports
  const airportFlightCount = new Map<string, number>();
  const missingAirports = new Set<string>();

  for (const flight of history.flights) {
    for (const code of [flight.from, flight.to]) {
      if (!code) continue;
      if (airports.has(code)) {
        airportFlightCount.set(code, (airportFlightCount.get(code) ?? 0) + 1);
      } else {
        missingAirports.add(code);
      }
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
        coordinates = flight.track;
        trackedCount++;
      } else {
        coordinates = greatCircleArc(
          [fromAirport.lng, fromAirport.lat],
          [toAirport.lng, toAirport.lat]
        );
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
  console.log(`Routes: ${routeFeatures.length} (Tracked: ${trackedCount}, Great Circle: ${greatCircleCount}, Skipped: ${skippedCount})`);
  console.log(`Written ${GEOJSON_PATH} (${sizeKB} KB)`);
}

main();
