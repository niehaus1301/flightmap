import fs from "fs";
import path from "path";
import { type FlightHistory, flightKey } from "./types.js";

const ROOT = path.join(new URL(import.meta.url).pathname, "../..");
const HISTORY_PATH = path.join(ROOT, "data/flight-history.json");
const FR24_DIR = path.join(ROOT, "fr24");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function parseFr24Csv(filePath: string): {
  date: string;
  flightNumber: string;
  track: [number, number][];
} {
  const base = path.basename(filePath, ".csv");
  const flightNumber = base.split("_")[0].trim().toUpperCase();

  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    throw new Error(`CSV has no data rows: ${filePath}`);
  }

  const header = parseCsvLine(lines[0]);
  const utcIdx = header.indexOf("UTC");
  const posIdx = header.indexOf("Position");

  if (utcIdx < 0 || posIdx < 0) {
    throw new Error(`Unexpected CSV header in ${filePath}`);
  }

  const track: [number, number][] = [];
  let date = "";

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const utc = row[utcIdx]?.trim();
    const position = row[posIdx]?.trim();

    if (!utc || !position) continue;

    const d = new Date(utc);
    if (Number.isNaN(d.getTime())) continue;
    if (!date) date = d.toISOString().slice(0, 10);

    const [latStr, lonStr] = position.split(",").map((s) => s.trim());
    const lat = Number.parseFloat(latStr);
    const lon = Number.parseFloat(lonStr);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    track.push([lon, lat]);
  }

  if (!date) {
    throw new Error(`Could not parse UTC date from ${filePath}`);
  }

  if (track.length === 0) {
    throw new Error(`No valid coordinates found in ${filePath}`);
  }

  return { date, flightNumber, track };
}

function main() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.error("flight-history.json not found");
    process.exit(1);
  }

  if (!fs.existsSync(FR24_DIR)) {
    console.error("fr24 directory not found");
    process.exit(1);
  }

  const history: FlightHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  const byKey = new Map(history.flights.map((f) => [flightKey(f), f]));

  const csvFiles = fs
    .readdirSync(FR24_DIR)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(FR24_DIR, f));

  if (csvFiles.length === 0) {
    console.log("No CSV files found in fr24/");
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const csvPath of csvFiles) {
    try {
      const parsed = parseFr24Csv(csvPath);
      const matches = history.flights.filter(
        (f) => f.date === parsed.date && f.flightNumber.replace(/\s+/g, "").toUpperCase() === parsed.flightNumber
      );

      if (matches.length === 0) {
        console.log(
          `Skip ${path.basename(csvPath)}: no flight match for ${parsed.date} ${parsed.flightNumber}`
        );
        skipped++;
        continue;
      }

      if (matches.length > 1) {
        console.log(
          `Skip ${path.basename(csvPath)}: ambiguous match (${matches.length} flights) for ${parsed.date} ${parsed.flightNumber}`
        );
        skipped++;
        continue;
      }

      const flight = matches[0];
      const key = flightKey(flight);
      const target = byKey.get(key);

      if (!target) {
        console.log(`Skip ${path.basename(csvPath)}: internal key mismatch`);
        skipped++;
        continue;
      }

      target.track = parsed.track;
      target.trackSource = "fr24";

      console.log(
        `Imported ${path.basename(csvPath)} -> ${target.date} ${target.flightNumber} ${target.from}→${target.to} (${parsed.track.length} points)`
      );
      imported++;
    } catch (err) {
      console.log(`Skip ${path.basename(csvPath)}: ${String(err)}`);
      skipped++;
    }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`\nDone. Imported ${imported}, skipped ${skipped}.`);
}

main();
