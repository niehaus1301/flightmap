import fs from "fs";
import path from "path";
import {
  type Flight,
  type FlightWithTrack,
  type FlightHistory,
  type FlightsFile,
  flightKey,
} from "./types.js";

const ROOT = path.join(new URL(import.meta.url).pathname, "../..");
const FLIGHTS_PATH = path.join(ROOT, "generated/flights.json");
const HISTORY_PATH = path.join(ROOT, "data/flight-history.json");

const flightsFile: FlightsFile = JSON.parse(
  fs.readFileSync(FLIGHTS_PATH, "utf-8")
);
console.log(`Loaded ${flightsFile.flights.length} flights from flights.json`);

let history: FlightHistory = { flights: [] };
if (fs.existsSync(HISTORY_PATH)) {
  history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  console.log(
    `Loaded ${history.flights.length} flights from flight-history.json`
  );
} else {
  console.log("No flight-history.json found, starting fresh");
}

const sourceByKey = new Map(
  flightsFile.flights.map((f) => [flightKey(f), f] as const)
);

const beforePruneCount = history.flights.length;
history.flights = history.flights.filter((f) => sourceByKey.has(flightKey(f)));
const removedCount = beforePruneCount - history.flights.length;
if (removedCount > 0) {
  console.log(`Removed ${removedCount} stale flights from history.`);
}

// FlightRadar24 fills in aircraft type and registration some time after the
// flight itself appears, so refresh the flights we already know about instead
// of freezing whatever the export happened to hold on the day we first saw
// them. Locally enriched fields (the track) always win over the export.
let updatedCount = 0;
history.flights = history.flights.map((existing) => {
  const source = sourceByKey.get(flightKey(existing));
  if (!source) return existing;

  const merged: FlightWithTrack = { ...existing };
  for (const [key, value] of Object.entries(source) as [
    keyof Flight,
    Flight[keyof Flight]
  ][]) {
    // Never let a blank in the export erase something we already have.
    if (value === null || value === undefined) continue;
    if (merged[key] === value) continue;
    (merged[key] as Flight[keyof Flight]) = value;
    updatedCount++;
  }
  return merged;
});

if (updatedCount > 0) {
  console.log(`Updated ${updatedCount} fields on existing flights.`);
}

const existingKeys = new Set(history.flights.map((f) => flightKey(f)));
const newFlights = flightsFile.flights.filter(
  (f) => !existingKeys.has(flightKey(f))
);

if (newFlights.length > 0) {
  const enriched: FlightWithTrack[] = newFlights.map((f) => ({
    ...f,
    track: null,
    trackSource: null,
  }));

  history.flights.push(...enriched);
  history.flights.sort((a, b) => b.date.localeCompare(a.date));

  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  console.log(`Added ${newFlights.length} new flights.`);
}

if (removedCount === 0 && newFlights.length === 0 && updatedCount === 0) {
  console.log("No history changes needed.");
}

history.flights.sort((a, b) => b.date.localeCompare(a.date));
fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
console.log(`Synced history. Total: ${history.flights.length}`);
