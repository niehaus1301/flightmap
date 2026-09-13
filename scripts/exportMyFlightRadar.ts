import fs from "fs";
import path from "path";
import initCycleTLS from "cycletls";
import { type Flight } from "./types.js";
import {
  type FlightradarResponse,
  mergeFlights,
  parsePagedFlights,
  parseProfileFlightsHtml,
} from "./parseFlightradar.js";

const USERNAME = "Niehaus1301";
const MY_FLIGHTRADAR_URL = `https://my.flightradar24.com/public-scripts/flight-list/${USERNAME}`;
const PROFILE_URL = `https://my.flightradar24.com/${USERNAME}`;
const PROFILE_FLIGHTS_URL = `${PROFILE_URL}/flights`;

const OUTPUT_FILE_PATH = path.join(
  new URL(import.meta.url).pathname,
  "../../generated/flights.json"
);

// Chrome 124 on Linux JA3 — matches what cycletls's bundled utls advertises.
const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// The paging endpoint answers /<offset> with the rows AFTER that offset, and
// rejects anything below 1: 0, -1 and friends all come back as an empty list,
// which stops the paging before it has fetched a single row — that is how this
// export once wiped itself. So the two newest flights on the profile are
// unreachable here whatever offset is passed. The site has the same limit and
// works around it by rendering the first 50 rows into the profile page, using
// this endpoint only to load more, so that page is where those rows come from.
const FIRST_ROW = 1;
const PAGE_SIZE = 50;

const cycleTLS = await initCycleTLS();

async function fetchFlightradarFlights(
  start: number
): Promise<FlightradarResponse> {
  console.log("Fetching MyFlightradar for flights from index: " + start);
  const response = await cycleTLS(
    `${MY_FLIGHTRADAR_URL}/${start}`,
    {
      ja3: CHROME_JA3,
      userAgent: CHROME_UA,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        Referer: PROFILE_URL,
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

  return Object.keys(data).length === PAGE_SIZE
    ? { ...data, ...(await fetchFlightradarFlights(start + PAGE_SIZE)) }
    : data;
}

async function fetchProfilePage(): Promise<string> {
  console.log("Fetching the profile page for the rows paging cannot reach");
  const response = await cycleTLS(
    PROFILE_FLIGHTS_URL,
    {
      ja3: CHROME_JA3,
      userAgent: CHROME_UA,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: PROFILE_URL,
      },
    },
    "get"
  );

  const text = await response.text();

  if (response.status !== 200) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `Profile page returned status ${response.status}. ` +
        `Body starts with: ${snippet}`
    );
  }

  return text;
}

try {
  const paged: Flight[] = parsePagedFlights(
    await fetchFlightradarFlights(FIRST_ROW)
  );
  const fromProfile = parseProfileFlightsHtml(await fetchProfilePage());

  // Both sources failing open would look exactly like "the profile is empty",
  // and the sync step reads an empty export as "every flight was deleted".
  // Fail loudly instead of writing a file that destroys history.
  if (fromProfile.length === 0) {
    throw new Error(
      "Could not read any flights off the profile page. Its table layout has " +
        "probably changed — fix the parser rather than shipping a short export."
    );
  }

  const flights = mergeFlights(paged, fromProfile);

  if (flights.length === 0) {
    throw new Error(
      "MyFlightradar returned no flights. Refusing to overwrite flights.json."
    );
  }

  console.log(
    `Fetched ${paged.length} by paging + ${fromProfile.length} from the ` +
      `profile page = ${flights.length} flights`
  );
  console.log("Writing to " + OUTPUT_FILE_PATH);
  fs.mkdirSync(path.dirname(OUTPUT_FILE_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE_PATH, JSON.stringify({ flights }, null, 2));
} finally {
  await cycleTLS.exit();
}
