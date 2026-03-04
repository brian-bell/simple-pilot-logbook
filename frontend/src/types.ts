export interface Flight {
  id: number
  date: string
  aircraft_title: string | null
  aircraft_registration: string | null
  departure_icao: string | null
  departure_name: string | null
  departure_lat: number | null
  departure_lon: number | null
  arrival_icao: string | null
  arrival_name: string | null
  arrival_lat: number | null
  arrival_lon: number | null
  distance_nm: number | null
  elapsed_seconds: number | null
  max_altitude_ft: number | null
  landing_vs_fpm: number | null
  landing_g_force: number | null
  notes: string | null
  created_at: string
}

export interface FlightsResponse {
  flights: Flight[]
  total: number
  limit: number
  offset: number
}

export interface CurrentFlight {
  departure_icao: string | null
  departure_name: string | null
  departure_lat: number | null
  departure_lon: number | null
  aircraft_title: string | null
  aircraft_registration: string | null
  elapsed_seconds: number
  altitude_ft: number | null
}

export interface StatusResponse {
  connected: boolean
  state: 'DISCONNECTED' | 'ON_GROUND' | 'AIRBORNE'
  current_flight: CurrentFlight | null
}
