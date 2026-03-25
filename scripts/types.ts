export interface Flight {
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

export interface FlightWithTrack extends Flight {
  track: [number, number][] | null;
  trackSource: "aeroapi" | "fr24" | "none" | null;
}

export interface Airport {
  iata: string;
  name: string;
  lat: number;
  lng: number;
  country: string;
}

export interface FlightHistory {
  flights: FlightWithTrack[];
}

export interface FlightsFile {
  flights: Flight[];
}

export function flightKey(f: Pick<Flight, "date" | "flightNumber" | "from" | "to">): string {
  return `${f.date}_${f.flightNumber}_${f.from}_${f.to}`;
}
