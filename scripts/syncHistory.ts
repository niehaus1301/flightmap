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
const FLIGHTS_PATH = path.join(ROOT, "src/assets/flights.json");
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

const existingKeys = new Set(history.flights.map((f) => flightKey(f)));
const newFlights = flightsFile.flights.filter(
  (f) => !existingKeys.has(flightKey(f))
);

if (newFlights.length === 0) {
  console.log("No new flights to add.");
} else {
  const enriched: FlightWithTrack[] = newFlights.map((f) => ({
    ...f,
    track: null,
    trackSource: null,
  }));

  history.flights.push(...enriched);
  history.flights.sort((a, b) => b.date.localeCompare(a.date));

  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(
    `Added ${newFlights.length} new flights. Total: ${history.flights.length}`
  );
}
