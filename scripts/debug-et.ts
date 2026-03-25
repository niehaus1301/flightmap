const AEROAPI_KEY = process.env.AEROAPI_KEY ?? "";
const BASE = "https://aeroapi.flightaware.com/aeroapi";

async function get(endpoint: string) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { "x-apikey": AEROAPI_KEY },
  });
  return res.json();
}

// Check what /operators/ET returns (raw)
console.log("=== /operators/ET (raw) ===");
const op = await get("/operators/ET") as any;
console.log(JSON.stringify(op, null, 2));

// Try ETH (correct ICAO for Ethiopian)
console.log("\n=== /operators/ETH ===");
const op2 = await get("/operators/ETH") as any;
console.log(`  iata: ${op2.iata}, icao: ${op2.icao}, name: ${op2.name}`);

// Try the flight with ETH prefix
console.log("\n=== ETH322 (ADD→MBA, 2025-11-27) ===");
const d1 = await get("/history/flights/ETH322?start=2025-11-26&end=2025-11-29") as any;
console.log(`  Flights: ${d1.flights?.length ?? 0}`);
for (const f of d1.flights ?? []) {
  console.log(`  ${f.ident} | ${f.origin?.code_iata} → ${f.destination?.code_iata} | ${f.scheduled_out}`);
}

console.log("\n=== ETH725 (VIE→ADD, 2025-11-26) ===");
const d2 = await get("/history/flights/ETH725?start=2025-11-25&end=2025-11-28") as any;
console.log(`  Flights: ${d2.flights?.length ?? 0}`);
for (const f of d2.flights ?? []) {
  console.log(`  ${f.ident} | ${f.origin?.code_iata} → ${f.destination?.code_iata} | ${f.scheduled_out}`);
}
