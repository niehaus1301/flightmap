// Temp debug script — safe to delete
const AEROAPI_KEY = process.env.AEROAPI_KEY ?? "";
const BASE = "https://aeroapi.flightaware.com/aeroapi";

async function get(endpoint: string) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { "x-apikey": AEROAPI_KEY },
  });
  return res.json();
}

const ident = process.argv[2] ?? "APG9784";
const start = process.argv[3] ?? "2026-02-18";
const end = process.argv[4] ?? "2026-02-21";

console.log(`Looking up ${ident} from ${start} to ${end}`);
const data = await get(`/history/flights/${encodeURIComponent(ident)}?start=${start}&end=${end}`) as any;
console.log(`Flights: ${data.flights?.length ?? 0}`);
for (const f of data.flights ?? []) {
  console.log(`  ${f.ident} | ${f.origin?.code_iata} → ${f.destination?.code_iata} | ${f.scheduled_out}`);
}
