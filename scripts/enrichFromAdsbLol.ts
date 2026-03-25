import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  type FlightWithTrack,
  type FlightHistory,
  type Airport,
  flightKey,
} from "./types.js";

// ── Paths ──────────────────────────────────────────────────────────────────────
const ROOT = path.join(new URL(import.meta.url).pathname, "../..");
const HISTORY_PATH = path.join(ROOT, "data/flight-history.json");
const AIRPORTS_CSV_PATH = path.join(ROOT, "data/airports.csv");

const ADSBLOL_BASE = "https://github.com/adsblol/globe_history";
const MAX_DATES_PER_RUN = parseInt(process.env.MAX_DATES ?? "3", 10);
const EARLIEST_DATE = "2023-01-01";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

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

  return airports;
}

// ── adsbdb: registration → ICAO24 ─────────────────────────────────────────────
async function lookupIcao24(registration: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(registration)}`;
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const data = await res.json();
      return (data?.response?.aircraft?.mode_s as string)?.toLowerCase() ?? null;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// ── Download file using streaming ──────────────────────────────────────────────
async function downloadToFile(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) return false;
    const readable = Readable.fromWeb(res.body as any);
    const writable = fs.createWriteStream(destPath);
    await pipeline(readable, writable);
    return true;
  } catch {
    return false;
  }
}

// ── adsb.lol trace parsing ─────────────────────────────────────────────────────
interface TraceJson {
  icao: string;
  r?: string;
  t?: string;
  timestamp: number;
  trace: number[][];
}

interface TraceLeg {
  coordinates: [number, number][];
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  startTime: number; // unix timestamp
}

function parseLegs(trace: TraceJson): TraceLeg[] {
  const legs: TraceLeg[] = [];
  let currentPoints: number[][] = [];

  for (const point of trace.trace) {
    const flags = point[6] ?? 0;
    if ((flags & 2) && currentPoints.length > 0) {
      legs.push(buildLeg(currentPoints, trace.timestamp));
      currentPoints = [];
    }
    currentPoints.push(point);
  }
  if (currentPoints.length > 0) {
    legs.push(buildLeg(currentPoints, trace.timestamp));
  }

  return legs;
}

function buildLeg(points: number[][], baseTimestamp: number): TraceLeg {
  const first = points[0];
  const last = points[points.length - 1];
  // trace format: [seconds_offset, lat, lng, alt, gs, track, flags, vrate, ...]
  // GeoJSON: [lng, lat]
  const coordinates: [number, number][] = points.map(
    (p) => [p[2], p[1]] as [number, number]
  );

  return {
    coordinates,
    startLat: first[1],
    startLng: first[2],
    endLat: last[1],
    endLng: last[2],
    startTime: baseTimestamp + first[0],
  };
}

// ── Haversine distance (km) ────────────────────────────────────────────────────
function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function flightToUnixTime(flight: FlightWithTrack): number {
  const [hours, minutes] = flight.departureTime.split(":").map(Number);
  const date = new Date(flight.date + "T00:00:00Z");
  date.setUTCHours(hours, minutes, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

// ── Find matching leg for a flight ─────────────────────────────────────────────
function findMatchingLeg(
  legs: TraceLeg[],
  depAirport: Airport,
  arrAirport: Airport,
  departureUnixTime: number
): TraceLeg | null {
  let bestMatch: TraceLeg | null = null;
  let bestTimeDiff = Infinity;

  for (const leg of legs) {
    // Skip very short legs (taxi, test, etc.)
    if (leg.coordinates.length < 5) continue;

    const depDist = distanceKm(
      leg.startLat,
      leg.startLng,
      depAirport.lat,
      depAirport.lng
    );
    const arrDist = distanceKm(
      leg.endLat,
      leg.endLng,
      arrAirport.lat,
      arrAirport.lng
    );

    // Within 100km of both airports
    if (depDist > 100 || arrDist > 100) continue;

    // Time match
    const timeDiff = Math.abs(leg.startTime - departureUnixTime);
    if (timeDiff < bestTimeDiff) {
      bestTimeDiff = timeDiff;
      bestMatch = leg;
    }
  }

  return bestMatch;
}

// ── Determine adsb.lol repo year for a date ────────────────────────────────────
function getRepoYear(date: string): string {
  return date.substring(0, 4);
}

// ── Download and extract traces for a date ─────────────────────────────────────
async function downloadAndExtract(
  date: string,
  icao24s: string[],
  tmpDir: string
): Promise<Map<string, TraceJson>> {
  const dateDotted = date.replace(/-/g, ".");
  const repoYear = getRepoYear(date);
  const tag = `v${dateDotted}-planes-readsb-prod-0`;
  const baseUrl = `${ADSBLOL_BASE}_${repoYear}/releases/download/${tag}`;

  const partA = path.join(tmpDir, "part.tar.aa");
  const partB = path.join(tmpDir, "part.tar.ab");
  const singleTar = path.join(tmpDir, "part.tar");

  // Try split tar first, then single tar
  console.log(`    Downloading ${tag}...`);
  let downloaded = await downloadToFile(`${baseUrl}/${tag}.tar.aa`, partA);
  let useSplit = false;
  if (downloaded) {
    const gotB = await downloadToFile(`${baseUrl}/${tag}.tar.ab`, partB);
    useSplit = gotB;
    if (!gotB) {
      // Maybe single tar?
      fs.renameSync(partA, singleTar);
    }
  } else {
    // Try single tar
    downloaded = await downloadToFile(`${baseUrl}/${tag}.tar`, singleTar);
  }

  if (!downloaded && !fs.existsSync(singleTar) && !fs.existsSync(partA)) {
    // Try staging
    const stagingTag = `v${dateDotted}-planes-readsb-staging-0`;
    const stagingBase = `${ADSBLOL_BASE}_${repoYear}/releases/download/${stagingTag}`;
    console.log(`    Prod not found, trying staging...`);
    downloaded = await downloadToFile(
      `${stagingBase}/${stagingTag}.tar.aa`,
      partA
    );
    if (downloaded) {
      const gotB = await downloadToFile(
        `${stagingBase}/${stagingTag}.tar.ab`,
        partB
      );
      useSplit = gotB;
    }
  }

  if (!downloaded && !fs.existsSync(singleTar) && !fs.existsSync(partA)) {
    console.log(`    ✗ No data available for ${date}`);
    return new Map();
  }

  // Build extraction paths - try both with and without wildcards
  const extractPaths = icao24s.map((hex) => {
    const bucket = (parseInt(hex, 16) % 256).toString(16).padStart(2, "0");
    return `trace_full_${hex}.json`;
  });

  // Extract using system tar with wildcards to handle unknown directory structure
  const catCmd = useSplit
    ? `cat "${partA}" "${partB}"`
    : `cat "${fs.existsSync(singleTar) ? singleTar : partA}"`;

  const wildcardArgs = extractPaths
    .map((f) => `--wildcards '*/${f}'`)
    .join(" ");

  try {
    execSync(
      `${catCmd} | tar -xf - -C "${tmpDir}" ${wildcardArgs} 2>/dev/null || true`,
      { timeout: 600000, stdio: "pipe" }
    );
  } catch {
    // tar might return non-zero if some files aren't found — that's OK
  }

  // Clean up tar files to save disk space
  for (const f of [partA, partB, singleTar]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // Find and parse extracted trace files
  const traces = new Map<string, TraceJson>();
  for (const hex of icao24s) {
    const filename = `trace_full_${hex}.json`;
    // Search for the file anywhere under tmpDir
    try {
      const found = execSync(`find "${tmpDir}" -name "${filename}" -type f`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!found) continue;
      const filePath = found.split("\n")[0];

      const raw = fs.readFileSync(filePath);
      let data: string;
      try {
        data = zlib.gunzipSync(raw).toString();
      } catch {
        data = raw.toString();
      }

      const trace: TraceJson = JSON.parse(data);
      if (trace.trace && trace.trace.length > 0) {
        traces.set(hex, trace);
      }
    } catch {
      // File not found
    }
  }

  console.log(
    `    Extracted ${traces.size}/${icao24s.length} trace files`
  );
  return traces;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.log("No flight-history.json found. Run sync-history first.");
    return;
  }

  const airports = loadAirports();
  console.log(`Loaded ${airports.size} airports`);

  const history: FlightHistory = JSON.parse(
    fs.readFileSync(HISTORY_PATH, "utf-8")
  );
  console.log(`Loaded ${history.flights.length} flights from history`);

  // Find flights needing enrichment (2023+ only, skip very recent)
  const now = Date.now();
  const needsTrack = history.flights.filter((f) => {
    if (f.track) return false;
    if (f.date < EARLIEST_DATE) return false;
    const flightTime = new Date(f.date + "T00:00:00Z").getTime();
    if (now - flightTime < TWO_DAYS_MS) return false;
    return true;
  });
  console.log(`${needsTrack.length} flights without tracks (2023+, >2 days old)`);

  if (needsTrack.length === 0) {
    console.log("Nothing to enrich.");
    return;
  }

  // Step 1: Resolve ICAO24 for flights with registration but no ICAO24
  const needsIcao = needsTrack.filter((f) => f.registration && !f.icao24);
  const uniqueRegs = [
    ...new Set(needsIcao.map((f) => f.registration!)),
  ];
  console.log(
    `\n=== Step 1: ICAO24 Lookup (${uniqueRegs.length} unique registrations) ===`
  );

  const regCache = new Map<string, string | null>();
  for (const reg of uniqueRegs) {
    console.log(`  ${reg}...`);
    const icao24 = await lookupIcao24(reg);
    regCache.set(reg, icao24);
    if (icao24) {
      console.log(`    → ${icao24}`);
    } else {
      console.log(`    → not found`);
    }
    await new Promise((r) => setTimeout(r, 500)); // rate limit
  }

  // Apply resolved ICAO24s to flights
  for (const f of needsIcao) {
    if (f.registration && regCache.has(f.registration)) {
      f.icao24 = regCache.get(f.registration) ?? null;
    }
  }

  // Step 2: Group enrichable flights by date
  const enrichable = needsTrack.filter((f) => f.icao24);
  const byDate = new Map<string, FlightWithTrack[]>();
  for (const f of enrichable) {
    const group = byDate.get(f.date) ?? [];
    group.push(f);
    byDate.set(f.date, group);
  }

  const allDates = [...byDate.keys()].sort().reverse();
  const dates = allDates.slice(0, MAX_DATES_PER_RUN);
  console.log(
    `\n=== Step 2: Enrich from adsb.lol (${dates.length}/${allDates.length} dates) ===`
  );

  let enrichedCount = 0;

  for (const date of dates) {
    const flights = byDate.get(date)!;
    const icao24s = [...new Set(flights.map((f) => f.icao24!))];
    console.log(
      `\n  ${date}: ${flights.length} flights, ${icao24s.length} aircraft`
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsblol-"));
    try {
      const traces = await downloadAndExtract(date, icao24s, tmpDir);

      for (const f of flights) {
        const trace = traces.get(f.icao24!);
        if (!trace) {
          console.log(
            `    ${f.flightNumber}: no trace file`
          );
          continue;
        }

        const depAirport = f.from ? airports.get(f.from) : undefined;
        const arrAirport = f.to ? airports.get(f.to) : undefined;
        if (!depAirport || !arrAirport) {
          console.log(
            `    ${f.flightNumber}: missing airport data`
          );
          continue;
        }

        const legs = parseLegs(trace);
        const depTime = flightToUnixTime(f);
        const match = findMatchingLeg(legs, depAirport, arrAirport, depTime);

        if (match) {
          f.track = match.coordinates;
          f.trackSource = "adsblol";
          enrichedCount++;
          console.log(
            `    ${f.flightNumber}: ✓ ${match.coordinates.length} points`
          );
        } else {
          console.log(
            `    ${f.flightNumber}: ✗ no matching leg in ${legs.length} legs`
          );
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Save
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`Enriched ${enrichedCount} flights`);
  if (dates.length < allDates.length) {
    console.log(
      `${allDates.length - dates.length} dates remaining (run again or increase MAX_DATES)`
    );
  }
}

main();
