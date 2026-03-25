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

function loadAirports(): Map<string, Airport> {
  const csv = fs.readFileSync(AIRPORTS_CSV_PATH, "utf-8");
  const lines = csv.split("\n");
  const airports = new Map<string, Airport>();

  const parsed: ReturnType<typeof parseCSVLine>[] = [];
  // First pass: load all airports with an IATA code
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    parsed.push(fields);
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

  // Second pass: recover IATA codes for closed airports from keywords
  for (const fields of parsed) {
    if (fields[13]?.trim() || fields[2]?.trim() !== "closed") continue;
    const keywords = fields[18]?.trim();
    if (!keywords) continue;
    const codes = keywords.split(",").map((k) => k.trim()).filter((k) => /^[A-Z]{3}$/.test(k));
    const match = codes.find((c) => !airports.has(c));
    if (!match) continue;
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
  return airports;
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
        // Just two endpoints — Mapbox client handles geodesic rendering
        coordinates = [
          [fromAirport.lng, fromAirport.lat],
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
  console.log(`Routes: ${routeFeatures.length} (Tracked: ${trackedCount}, Great Circle: ${greatCircleCount}, Skipped: ${skippedCount})`);
  console.log(`Written ${GEOJSON_PATH} (${sizeKB} KB)`);
}

main();
