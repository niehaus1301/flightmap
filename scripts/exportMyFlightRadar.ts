import fs from "fs";
import path from "path";

const MY_FLIGHTRADAR_URL =
  "https://my.flightradar24.com/public-scripts/flight-list/Niehaus1301";

const OUTPUT_FILE_PATH = path.join(
  new URL(import.meta.url).pathname,
  "../../src/assets/flights.json"
);

interface Flight {
  date: string;
  flightNumber: string;
  from: string;
  to: string;
  distance: number;
  departureTime: string;
  arrivalTime: string;
  airline: string;
  aircraft: string | null;
  registration: string | null;
}

type FlightradarResponse = Record<string, string[]>;

async function fetchFlightradarFlights(
  start: number
): Promise<FlightradarResponse> {
  console.log("Fetching MyFlightradar for flights from index: " + start);
  const response = await fetch(MY_FLIGHTRADAR_URL + "/" + start);
  const data: FlightradarResponse = await response.json();
  return Object.keys(data).length === 50
    ? { ...data, ...(await fetchFlightradarFlights(start + 50)) }
    : data;
}

const dateRegex = /inner-date'>(\d{4}-\d{2}-\d{2})</;
const anchorTextRegex = /<a\s[^>]*>([^<]+)<\/a>/;

function extractAnchorText(html: string): string | null {
  const match = anchorTextRegex.exec(html);
  if (match) return match[1] || null;
  if (html.includes("<")) return null;
  return html.trim() || null;
}

const flightsRaw = await fetchFlightradarFlights(1);

const flights: Flight[] = Object.keys(flightsRaw).map((key) => {
  const r = flightsRaw[key];
  const dateMatch = dateRegex.exec(r[0]);
  if (!dateMatch) {
    throw new Error(`Could not parse date for flight ${key}`);
  }
  return {
    date: dateMatch[1],
    flightNumber: r[1].trim(),
    from: extractAnchorText(r[2]) ?? "",
    to: extractAnchorText(r[3]) ?? "",
    distance: parseInt(r[4], 10) || 0,
    departureTime: r[5].trim(),
    arrivalTime: r[6].trim(),
    airline: extractAnchorText(r[7]) ?? "",
    aircraft: extractAnchorText(r[8]),
    registration: r[9].trim() || null,
  };
});

console.log(`Fetched ${flights.length} flights`);
console.log("Writing to " + OUTPUT_FILE_PATH);
fs.writeFileSync(OUTPUT_FILE_PATH, JSON.stringify({ flights }, null, 2));