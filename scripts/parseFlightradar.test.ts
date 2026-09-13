import { parseProfileFlightsHtml, mergeFlights, parsePagedFlights, parseDistance } from "./parseFlightradar.js";

// Markup copied verbatim from https://my.flightradar24.com/Niehaus1301/flights
const html = `<table>
<tr><th>Date</th><th>Flight</th><th>Reg</th><th>From</th><th>To</th><th>Dist</th><th>Dep</th><th>Arr</th><th>Airline</th><th>Aircraft</th><th>Seat</th><th></th><th></th></tr>
<tr><td><span class="inner-date">2026-09-23</span></td><td>TS376</td><td></td><td><span class="tooltip" data-tooltip-value="Toronto / Pearson">YYZ</span></td><td><span class="tooltip" data-tooltip-value="Amsterdam / Schiphol">AMS</span></td><td>5,996</td><td>23:45</td><td>13:10</td><td><span class="tooltip" data-tooltip-value="Air Transat">TSC</span></td><td><span class="tooltip" data-tooltip-value="Airbus A321LR">A21N</span></td><td></td><td><span></span></td><td><span class="circle-icon class-economy tooltip" data-tooltip-value="Economy">E</span></td></tr>
<tr><td><span class="inner-date">2026-09-09</span></td><td>TS231</td><td>C-GOKC</td><td><span class="tooltip" data-tooltip-value="Dublin / Dublin">DUB</span></td><td><span class="tooltip" data-tooltip-value="Toronto / Pearson">YYZ</span></td><td>5,267</td><td>13:15</td><td>15:50</td><td><span class="tooltip" data-tooltip-value="Air Transat">TSC</span></td><td><span class="tooltip" data-tooltip-value="Airbus A321neo">A21N</span></td><td></td><td><span></span></td><td></td></tr>
<tr><td><span class="inner-date">2026-09-09</span></td><td>FR5126</td><td>9H-QEF</td><td><span class="tooltip" data-tooltip-value="Hamburg / Fuhlsbuttel">HAM</span></td><td><span class="tooltip" data-tooltip-value="Dublin / Dublin">DUB</span></td><td>1,073</td><td>09:55</td><td>11:00</td><td><span class="tooltip" data-tooltip-value="Ryanair">RYR</span></td><td><span class="tooltip" data-tooltip-value="Boeing 737-800">B738</span></td><td></td><td><span></span></td><td></td></tr>
</table>`;

// A row exactly as the paging endpoint returns it (same flight as the third row above).
const pagedRaw = {
  "2": [
    "<span class='inner-date'>2026-09-09</span><span class='inner-actions'><a href='/edit-flight/x'>Edit</a></span>",
    "FR5126",
    '<a href="https://my.flightradar24.com/airport/hamburg-fuhlsbuttel-eddh" class="show-hovercard">HAM</a>',
    '<a href="https://my.flightradar24.com/airport/dublin-eidw" class="show-hovercard">DUB</a>',
    "667", "09:55", "11:00",
    '<a href="https://my.flightradar24.com/airline/ryanair-ryr">RYR</a>',
    '<a href="https://my.flightradar24.com/aircraft/x" data-hovercard-content="Boeing 737-800">B738</a>',
    "9H-QEF",
  ],
};

let fails = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const rows = parseProfileFlightsHtml(html);
check("profile page yields 3 rows (header skipped)", rows.length === 3, rows.length);
check("TS376 YYZ->AMS parsed", rows[0].flightNumber === "TS376" && rows[0].from === "YYZ" && rows[0].to === "AMS", rows[0]);
check("TS231 DUB->YYZ parsed with registration", rows[1].flightNumber === "TS231" && rows[1].from === "DUB" && rows[1].to === "YYZ" && rows[1].registration === "C-GOKC", rows[1]);
check("aircraft + airline read from tooltip spans", rows[1].aircraft === "A21N" && rows[1].airline === "TSC", rows[1]);
check("empty registration becomes null", rows[0].registration === null, rows[0].registration);
check("5,267 km -> 3273 mi (no comma truncation)", rows[1].distance === 3273, rows[1].distance);
check("1,073 km -> 667 mi, matching the paged value", rows[2].distance === 667, rows[2].distance);

const paged = parsePagedFlights(pagedRaw);
check("paged row still parses", paged.length === 1 && paged[0].flightNumber === "FR5126" && paged[0].from === "HAM", paged[0]);

const merged = mergeFlights(paged, rows);
check("merge adds only the unreachable rows", merged.length === 3, merged.map((f) => f.flightNumber));
check("no duplicate FR5126", merged.filter((f) => f.flightNumber === "FR5126").length === 1);
check("the two new flights are present", merged.some((f) => f.flightNumber === "TS231") && merged.some((f) => f.flightNumber === "TS376"));

check("parseDistance strips separators", parseDistance("5,996") === 5996 && parseDistance("0") === 0 && parseDistance("") === 0);

console.log(fails === 0 ? "\nAll checks passed" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
