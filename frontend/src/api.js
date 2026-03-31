import { gql, GraphQLClient } from "graphql-request";

const FLIGHTS_LIST_DOCUMENT = gql`
  query FlightsList($limit: Int!, $offset: Int!) {
    flightsList(limit: $limit, offset: $offset) {
      flights {
        id
        date
        aircraft_title
        aircraft_registration
        departure_icao
        departure_name
        departure_lat
        departure_lon
        arrival_icao
        arrival_name
        arrival_lat
        arrival_lon
        distance_nm
        elapsed_seconds
        max_altitude_ft
        landing_vs_fpm
        landing_g_force
        notes
        created_at
      }
      total
      limit
      offset
    }
  }
`;

const DELETE_FLIGHT_DOCUMENT = gql`
  mutation DeleteFlight($id: ID!) {
    deleteFlight(id: $id) {
      deleted
    }
  }
`;

const DEFAULT_CONFIG = {
  graphql: {
    enabled: false,
    url: null,
    headers: {},
    use_local_fallback: true,
  },
};

function normalizeFlight(flight) {
  return {
    id: flight.id,
    date: flight.date ?? null,
    aircraft_title: flight.aircraft_title ?? null,
    aircraft_registration: flight.aircraft_registration ?? null,
    departure_icao: flight.departure_icao ?? null,
    departure_name: flight.departure_name ?? null,
    departure_lat: flight.departure_lat ?? null,
    departure_lon: flight.departure_lon ?? null,
    arrival_icao: flight.arrival_icao ?? null,
    arrival_name: flight.arrival_name ?? null,
    arrival_lat: flight.arrival_lat ?? null,
    arrival_lon: flight.arrival_lon ?? null,
    distance_nm: flight.distance_nm ?? null,
    elapsed_seconds: flight.elapsed_seconds ?? null,
    max_altitude_ft: flight.max_altitude_ft ?? null,
    landing_vs_fpm: flight.landing_vs_fpm ?? null,
    landing_g_force: flight.landing_g_force ?? null,
    notes: flight.notes ?? null,
    created_at: flight.created_at ?? null,
  };
}

function normalizeFlightsPayload(payload, limit, offset, source) {
  const flights = Array.isArray(payload?.flights)
    ? payload.flights.map(normalizeFlight)
    : [];
  return {
    source,
    flights,
    total: Number(payload?.total ?? flights.length),
    limit: Number(payload?.limit ?? limit),
    offset: Number(payload?.offset ?? offset),
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function graphqlClient(config) {
  return new GraphQLClient(config.graphql.url, {
    headers: config.graphql.headers ?? {},
  });
}

async function fetchLocalFlights(limit, offset) {
  const payload = await fetchJson(`/api/flights?limit=${limit}&offset=${offset}`);
  return normalizeFlightsPayload(payload, limit, offset, "local");
}

async function fetchGraphqlFlights(config, limit, offset) {
  const client = graphqlClient(config);
  const payload = await client.request(FLIGHTS_LIST_DOCUMENT, { limit, offset });
  if (!payload?.flightsList) {
    throw new Error("Invalid GraphQL flights response.");
  }
  return normalizeFlightsPayload(payload.flightsList, limit, offset, "graphql");
}

export async function fetchAppConfig() {
  try {
    const payload = await fetchJson("/api/config");
    return {
      ...DEFAULT_CONFIG,
      ...payload,
      graphql: {
        ...DEFAULT_CONFIG.graphql,
        ...(payload?.graphql ?? {}),
        headers: payload?.graphql?.headers ?? {},
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function fetchStatus() {
  return fetchJson("/api/status");
}

export async function fetchFlights({ config, limit, offset }) {
  if (config?.graphql?.enabled && config?.graphql?.url) {
    try {
      return await fetchGraphqlFlights(config, limit, offset);
    } catch (error) {
      if (!config.graphql.use_local_fallback) {
        throw error;
      }
    }
  }

  return fetchLocalFlights(limit, offset);
}

async function deleteLocalFlight(id) {
  const response = await fetch(`/api/flights/${id}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return id;
}

async function deleteGraphqlFlight(config, id) {
  const client = graphqlClient(config);
  const payload = await client.request(DELETE_FLIGHT_DOCUMENT, { id: String(id) });
  const deleted = payload?.deleteFlight;
  if (typeof deleted === "boolean" && deleted) {
    return id;
  }
  if (deleted?.deleted != null) {
    return deleted.deleted;
  }
  throw new Error("Invalid GraphQL delete response.");
}

export async function deleteFlight({ config, id, source }) {
  if (source === "graphql" && config?.graphql?.enabled && config?.graphql?.url) {
    return deleteGraphqlFlight(config, id);
  }

  return deleteLocalFlight(id);
}
