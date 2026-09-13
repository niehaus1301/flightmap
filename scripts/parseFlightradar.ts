import { type Flight } from "./types.js";

/**
 * Parsing for the two shapes MyFlightradar24 hands out the same flight list in:
 * the JSON rows of the paging endpoint, and the table on the profile page.
 * Kept apart from the fetching so it can be exercised without a network.
 */

export type FlightradarRow = string[];
export type FlightradarResponse = Record<string, FlightradarRow>;

const KM_PER_MILE = 1.60934;

const dateRegex = /inner-date[^>]*>(\d{4}-\d{2}-\d{2})</;
const anchorTextRegex = /<a\s[^>]*>([^<]+)<\/a>/;

export function extractAnchorText(html: string): string | null {
  const match = anchorTextRegex.exec(html);
  if (match) return match[1] || null;
  if (html.includes("<")) return null;
  return html.trim() || null;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * "5,996" -> 5996. parseInt on its own stops at the separator, which turned
 * every leg over 999 into a single-digit distance.
 */
export function parseDistance(raw: string): number {
  return parseInt(raw.replace(/[^\d]/g, ""), 10) || 0;
}

export function flightKey(f: Flight): string {
  return `${f.date}_${f.flightNumber}_${f.from}_${f.to}`;
}

/** Rows from the paging endpoint. Distances are miles. */
export function parsePagedFlights(response: FlightradarResponse): Flight[] {
  return Object.keys(response).map((key) => {
    const r = response[key];
    const dateMatch = dateRegex.exec(r[0]);
    if (!dateMatch) {
      throw new Error(`Could not parse date for flight ${key}`);
    }
    return {
      date: dateMatch[1],
      flightNumber: r[1].trim(),
      from: extractAnchorText(r[2]) ?? "",
      to: extractAnchorText(r[3]) ?? "",
      distance: parseDistance(r[4]),
      departureTime: r[5].trim(),
      arrivalTime: r[6].trim(),
      airline: extractAnchorText(r[7]) ?? "",
      aircraft: extractAnchorText(r[8]),
      registration: r[9].trim() || null,
    };
  });
}

/**
 * Rows from the profile page's own table:
 * Date | Flight | Reg | From | To | Dist | Dep | Arr | Airline | Aircraft | ...
 * Distances here are kilometres while the paging endpoint reports miles, so
 * convert to keep the file in one unit.
 */
export function parseProfileFlightsHtml(html: string): Flight[] {
  const flights: Flight[] = [];

  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (m) => m[1]
    );
    if (cells.length < 10) continue;

    const dateMatch = dateRegex.exec(cells[0]);
    const from = stripTags(cells[3]);
    const to = stripTags(cells[4]);
    if (!dateMatch || !from || !to) continue;

    flights.push({
      date: dateMatch[1],
      flightNumber: stripTags(cells[1]),
      from,
      to,
      distance: Math.round(parseDistance(cells[5]) / KM_PER_MILE),
      departureTime: stripTags(cells[6]),
      arrivalTime: stripTags(cells[7]),
      airline: stripTags(cells[8]),
      aircraft: stripTags(cells[9]) || null,
      registration: stripTags(cells[2]) || null,
    });
  }

  return flights;
}

/**
 * The paged rows win: they are what this export has always used, and they are
 * already in miles. The profile page only contributes the rows paging cannot
 * reach — in practice the two newest flights.
 */
export function mergeFlights(paged: Flight[], fromProfile: Flight[]): Flight[] {
  const seen = new Set(paged.map(flightKey));
  return [...fromProfile.filter((f) => !seen.has(flightKey(f))), ...paged];
}
