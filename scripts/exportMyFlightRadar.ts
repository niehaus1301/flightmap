import fs from "fs";
import path from "path";
import initCycleTLS from "cycletls";

const MY_FLIGHTRADAR_URL =
  "https://my.flightradar24.com/public-scripts/flight-list/Niehaus1301";

const OUTPUT_FILE_PATH = path.join(
  new URL(import.meta.url).pathname,
  "../../generated/flights.json"
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

// Chrome 124 on Linux JA3 — matches what cycletls's bundled utls advertises.
const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const cycleTLS = await initCycleTLS();

async function fetchFlightradarFlights(
  start: number
): Promise<FlightradarResponse> {
  console.log("Fetching MyFlightradar for flights from index: " + start);
  const response = await cycleTLS(
    MY_FLIGHTRADAR_URL + "/" + start,
    {
      ja3: CHROME_JA3,
      userAgent: CHROME_UA,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://my.flightradar24.com/Niehaus1301",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    },
    "get"
  );

  const text = await response.text();

  if (response.status !== 200) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `MyFlightradar returned status ${response.status}. ` +
        `Body starts with: ${snippet}`
    );
  }

  let data: FlightradarResponse;
  try {
    data = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `MyFlightradar returned non-JSON (status ${response.status}). ` +
        `Body starts with: ${snippet}`
    );
  }
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

try {
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
  fs.mkdirSync(path.dirname(OUTPUT_FILE_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE_PATH, JSON.stringify({ flights }, null, 2));
} finally {
  await cycleTLS.exit();
}
