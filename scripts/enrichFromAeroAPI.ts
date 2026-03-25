import fs from "fs";
import path from "path";
import { type FlightWithTrack, type FlightHistory } from "./types.js";

const AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi";
const AEROAPI_KEY = process.env.AEROAPI_KEY;
const ROOT = path.join(new URL(import.meta.url).pathname, "../..");
const HISTORY_PATH = path.join(ROOT, "data/flight-history.json");
const MAX_FLIGHTS = parseInt(process.env.MAX_FLIGHTS ?? "50", 10);
const REQUEST_DELAY_MS = 10_000; // ~6 req/min, well under the 10/min Personal tier limit

if (!AEROAPI_KEY) {
  console.error("AEROAPI_KEY environment variable is required");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function aeroGet(endpoint: string): Promise<unknown> {
  const res = await fetch(`${AEROAPI_BASE}${endpoint}`, {
    headers: { "x-apikey": AEROAPI_KEY! },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AeroAPI ${res.status}: ${body}`);
  }
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FlightResult = { flights?: Array<Record<string, unknown>> };

/** Build candidate idents to try, in priority order */
function buildIdents(flight: FlightWithTrack): string[] {
  const idents: string[] = [];
  // 1. IATA flight number as-is (e.g. "VJ501")
  const iata = flight.flightNumber.replace(/\s+/g, "");
  idents.push(iata);
  // 2. ICAO callsign: ICAO airline code + numeric flight suffix
  //    IATA airline codes are always 2 chars, so slice(2) gives the flight number
  if (flight.airline && iata.length > 2) {
    const icao = flight.airline + iata.slice(2);
    if (icao !== iata) idents.push(icao);
  }
  // 3. Registration (tail number) — works as an ident in AeroAPI
  if (flight.registration) {
    idents.push(flight.registration);
  }
  return idents;
}

/** Try each ident until we find a flight matching the origin/destination */
async function findFlight(
  flight: FlightWithTrack,
  prefix: string,
  startStr: string,
  endStr: string
): Promise<Record<string, unknown> | null> {
  const idents = buildIdents(flight);
  for (const ident of idents) {
    const data = (await aeroGet(
      `${prefix}/flights/${encodeURIComponent(ident)}?start=${startStr}&end=${endStr}`
    )) as FlightResult;
    await sleep(REQUEST_DELAY_MS);

    if (!data.flights?.length) {
      console.log(`  No results for ident "${ident}"`);
      continue;
    }

    const matched = data.flights.find((f) => {
      const origin = f.origin as { code_iata?: string } | undefined;
      const dest = f.destination as { code_iata?: string } | undefined;
      return origin?.code_iata === flight.from && dest?.code_iata === flight.to;
    });

    if (matched) {
      console.log(`  Matched via ident "${ident}"`);
      return matched;
    }
    console.log(
      `  Found ${data.flights.length} flights for "${ident}" but none matched ${flight.from} → ${flight.to}`
    );
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

const history: FlightHistory = JSON.parse(
  fs.readFileSync(HISTORY_PATH, "utf-8")
);

const unenriched = history.flights.filter((f) => f.track === null);
console.log(
  `Found ${unenriched.length} unenriched flights out of ${history.flights.length} total`
);

const toProcess = unenriched.slice(0, MAX_FLIGHTS);
console.log(`Processing up to ${toProcess.length} flights`);

let enriched = 0;

for (const flight of toProcess) {
  try {
    // Build search window: flight date ± 1 day to handle timezone differences
    const date = new Date(flight.date + "T00:00:00Z");
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 2);

    const ident = flight.flightNumber.replace(/\s+/g, "");
    const startStr = start.toISOString().split("T")[0];
    const endStr = end.toISOString().split("T")[0];

    // Use /history/ prefix for flights older than 10 days (requires Standard tier)
    const ageMs = Date.now() - date.getTime();
    const isHistorical = ageMs > 10 * 24 * 60 * 60 * 1000;
    const prefix = isHistorical ? "/history" : "";

    console.log(
      `\nLooking up ${ident} on ${flight.date} (${flight.from} → ${flight.to})${isHistorical ? " [history]" : ""}`
    );

    // Step 1: Find the flight by trying IATA, ICAO callsign, and registration
    const matched = await findFlight(flight, prefix, startStr, endStr);

    if (!matched) {
      console.log(`  Could not find flight via any ident`);
      continue;
    }

    const faFlightId = matched.fa_flight_id as string;

    // Step 3: Get track positions
    const trackData = (await aeroGet(
      `${prefix}/flights/${encodeURIComponent(faFlightId)}/track`
    )) as { positions?: Array<{ longitude: number; latitude: number }> };
    await sleep(REQUEST_DELAY_MS);

    if (!trackData.positions?.length) {
      console.log(`  No track positions for ${faFlightId}`);
      continue;
    }

    // Step 4: Extract coordinates as [lng, lat]
    const track: [number, number][] = trackData.positions.map((p) => [
      p.longitude,
      p.latitude,
    ]);

    flight.track = track;
    flight.trackSource = "aeroapi";
    enriched++;
    console.log(`  Got ${track.length} track positions`);
  } catch (err) {
    console.error(`  Error enriching ${flight.flightNumber}: ${err}`);
    await sleep(REQUEST_DELAY_MS);
  }
}

// Save updated history
fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
console.log(`\nDone. Enriched ${enriched}/${toProcess.length} flights.`);
