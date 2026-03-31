import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  deleteFlight,
  fetchAppConfig,
  fetchFlights,
  fetchStatus,
} from "./api";

const STATUS_INTERVAL = 3_000;
const FLIGHTS_INTERVAL = 10_000;
const FLIGHT_LIMIT = 200;
const DEFAULT_STATUS = {
  connected: false,
  state: "DISCONNECTED",
  current_flight: null,
};

function fmtDuration(secs) {
  if (secs == null) return "—";
  const rounded = Math.round(secs);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtVS(fpm) {
  if (fpm == null) return { text: "—", cls: "" };
  const abs = Math.abs(fpm);
  const text = `${Math.round(fpm)} fpm`;
  let cls = "";
  if (abs <= 200) cls = "vs-smooth";
  else if (abs <= 400) cls = "vs-firm";
  else cls = "vs-hard";
  return { text, cls };
}

function fmtG(g) {
  if (g == null) return "—";
  return `${g.toFixed(2)} G`;
}

function fmtNm(nm) {
  if (nm == null) return "—";
  return nm.toFixed(1);
}

function fmtAlt(ft) {
  if (ft == null) return "—";
  return `${Math.round(ft).toLocaleString()} ft`;
}

function fmtDate(iso) {
  if (!iso) return { date: "—", time: "" };
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { date: String(iso).slice(0, 10), time: "" };
  }
  return {
    date: parsed.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    time: parsed.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function routeLabel(flight, which) {
  const icao = flight[`${which}_icao`];
  const lat = flight[`${which}_lat`];
  const lon = flight[`${which}_lon`];
  if (icao) return icao;
  if (lat != null && lon != null) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    return `${ns}${Math.abs(lat).toFixed(1)} ${ew}${Math.abs(lon).toFixed(1)}`;
  }
  return "—";
}

function sortFlights(flights, sortCol, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...flights].sort((a, b) => {
    let va;
    let vb;
    switch (sortCol) {
      case "date":
        va = a.date || "";
        vb = b.date || "";
        break;
      case "aircraft":
        va = a.aircraft_registration || a.aircraft_title || "";
        vb = b.aircraft_registration || b.aircraft_title || "";
        break;
      case "from":
        va = a.departure_icao || "";
        vb = b.departure_icao || "";
        break;
      case "to":
        va = a.arrival_icao || "";
        vb = b.arrival_icao || "";
        break;
      case "distance_nm":
        va = a.distance_nm ?? -Infinity;
        vb = b.distance_nm ?? -Infinity;
        break;
      case "elapsed":
        va = a.elapsed_seconds ?? -Infinity;
        vb = b.elapsed_seconds ?? -Infinity;
        break;
      case "max_alt":
        va = a.max_altitude_ft ?? -Infinity;
        vb = b.max_altitude_ft ?? -Infinity;
        break;
      case "landing_vs":
        va = a.landing_vs_fpm ?? Infinity;
        vb = b.landing_vs_fpm ?? Infinity;
        break;
      case "landing_g":
        va = a.landing_g_force ?? -Infinity;
        vb = b.landing_g_force ?? -Infinity;
        break;
      default:
        va = "";
        vb = "";
    }
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
}

function sortClass(currentCol, sortCol, sortDir) {
  if (currentCol !== sortCol) return "sortable";
  return `sortable ${sortDir === "asc" ? "sort-asc" : "sort-desc"}`;
}

function removeFlightFromPayload(payload, id) {
  if (!payload) return payload;
  const flights = payload.flights.filter((flight) => String(flight.id) !== String(id));
  return {
    ...payload,
    flights,
    total: Math.max((payload.total ?? flights.length) - 1, 0),
  };
}

function Header({ status }) {
  const connected = status?.connected;
  const state = status?.state;

  let dotClass = "status-dot disconnected";
  let label = "Disconnected";
  if (state === "AIRBORNE") {
    dotClass = "status-dot airborne";
    label = "In Flight";
  } else if (connected) {
    dotClass = "status-dot connected";
    label = "Connected";
  }

  return (
    <header className="app-header">
      <div className="header-left">
        <span className="header-icon">&#9992;</span>
        <h1>Pilot Logbook</h1>
      </div>
      <div className="header-right">
        <span className="status-label">{label}</span>
        <span className={dotClass}></span>
      </div>
    </header>
  );
}

function ActiveBanner({ status }) {
  const currentFlight = status?.current_flight;
  if (status?.state !== "AIRBORNE" || !currentFlight) {
    return null;
  }

  const aircraft = currentFlight.aircraft_registration
    || currentFlight.aircraft_title?.split(" ").slice(0, 3).join(" ")
    || "—";

  return (
    <div className="active-banner">
      <div className="banner-row">
        <span className="banner-segment">
          <span className="banner-key">From</span>
          <strong>{currentFlight.departure_icao || "—"}</strong>
        </span>
        <span className="banner-arrow">&#10132;</span>
        <span className="banner-segment">
          <span className="banner-key">Aircraft</span>
          <strong>{aircraft}</strong>
        </span>
        <span className="banner-segment">
          <span className="banner-key">Altitude</span>
          <strong>
            {currentFlight.altitude_ft != null
              ? Math.round(currentFlight.altitude_ft).toLocaleString()
              : "—"}
          </strong>
          <span className="banner-unit">ft</span>
        </span>
        <span className="banner-segment">
          <span className="banner-key">Elapsed</span>
          <strong>{fmtDuration(currentFlight.elapsed_seconds)}</strong>
        </span>
      </div>
    </div>
  );
}

function Toolbar({ total, hasError, showingCached }) {
  let note = "";
  let noteClass = "toolbar-note";
  if (hasError && showingCached) {
    note = "Showing cached flights while the primary data source is unavailable.";
    noteClass = "toolbar-note cached";
  } else if (hasError) {
    note = "Could not load flights.";
    noteClass = "toolbar-note error";
  }

  return (
    <div className="toolbar">
      <span className="toolbar-title">Flight Log</span>
      {note ? <span className={noteClass}>{note}</span> : null}
      <span className="flight-count">
        {total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : ""}
      </span>
    </div>
  );
}

function EmptyState({ title, subtitle }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">&#9992;</span>
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{subtitle}</p>
    </div>
  );
}

function FlightModal({ flight, onClose }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!flight) {
    return null;
  }

  const departure = routeLabel(flight, "departure");
  const arrival = routeLabel(flight, "arrival");
  const { date, time } = fmtDate(flight.date);
  const vs = fmtVS(flight.landing_vs_fpm);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{`${departure} → ${arrival}`}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p className="detail-section">Route</p>
          <div className="detail-grid">
            <div className="detail-cell">
              <span className="detail-label">Departure</span>
              <span className="detail-value">{flight.departure_icao || "—"}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Arrival</span>
              <span className="detail-value">{flight.arrival_icao || "—"}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Dep. Name</span>
              <span className="detail-value">{flight.departure_name || "—"}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Arr. Name</span>
              <span className="detail-value">{flight.arrival_name || "—"}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Distance</span>
              <span className="detail-value">{fmtNm(flight.distance_nm)} nm</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Duration</span>
              <span className="detail-value">{fmtDuration(flight.elapsed_seconds)}</span>
            </div>
          </div>

          <p className="detail-section">Aircraft</p>
          <div className="detail-grid">
            <div className="detail-cell">
              <span className="detail-label">Registration</span>
              <span className="detail-value">{flight.aircraft_registration || "—"}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Type / Title</span>
              <span className="detail-value">{flight.aircraft_title || "—"}</span>
            </div>
          </div>

          <p className="detail-section">Performance</p>
          <div className="detail-grid">
            <div className="detail-cell">
              <span className="detail-label">Max Altitude</span>
              <span className="detail-value">{fmtAlt(flight.max_altitude_ft)}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Landing VS</span>
              <span className={`detail-value ${vs.cls}`.trim()}>{vs.text}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Landing G-Force</span>
              <span className="detail-value">{fmtG(flight.landing_g_force)}</span>
            </div>
            <div className="detail-cell">
              <span className="detail-label">Date / Time</span>
              <span className="detail-value">{`${date} ${time}`.trim()}</span>
            </div>
          </div>

          {flight.notes ? (
            <>
              <p className="detail-section">Notes</p>
              <div className="detail-grid">
                <div className="detail-cell" style={{ gridColumn: "1 / -1" }}>
                  <span className="detail-value">{flight.notes}</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [sortCol, setSortCol] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [selectedFlightId, setSelectedFlightId] = useState(null);

  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: fetchAppConfig,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: STATUS_INTERVAL,
    initialData: DEFAULT_STATUS,
  });

  const config = configQuery.data;

  const flightsQuery = useQuery({
    queryKey: ["flights", FLIGHT_LIMIT, 0, config?.graphql?.url ?? "local"],
    queryFn: () => fetchFlights({ config, limit: FLIGHT_LIMIT, offset: 0 }),
    enabled: Boolean(config),
    refetchInterval: FLIGHTS_INTERVAL,
    placeholderData: (previousData) => previousData,
  });

  const flightsPayload = flightsQuery.data;
  const flights = flightsPayload?.flights ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteFlight({ config, id, source: flightsPayload?.source }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["flights"] });
      const previousFlights = queryClient.getQueriesData({ queryKey: ["flights"] });
      queryClient.setQueriesData({ queryKey: ["flights"] }, (payload) =>
        removeFlightFromPayload(payload, id),
      );
      return { previousFlights };
    },
    onError: (_error, _id, context) => {
      if (!context?.previousFlights) return;
      context.previousFlights.forEach(([queryKey, payload]) => {
        queryClient.setQueryData(queryKey, payload);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["flights"] });
    },
  });

  const sorted = sortFlights(flights, sortCol, sortDir);
  const selectedFlight = flights.find(
    (flight) => String(flight.id) === String(selectedFlightId),
  ) || null;

  useEffect(() => {
    if (selectedFlightId == null) return;
    const stillExists = flights.some(
      (flight) => String(flight.id) === String(selectedFlightId),
    );
    if (!stillExists) {
      setSelectedFlightId(null);
    }
  }, [flights, selectedFlightId]);

  function toggleSort(column) {
    if (sortCol === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortCol(column);
    setSortDir(column === "date" ? "desc" : "asc");
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this flight entry?")) {
      return;
    }
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      // Query error state is surfaced in the toolbar.
    }
  }

  const showingCached = flightsQuery.isError && flights.length > 0;
  const hasFlights = sorted.length > 0;
  const isInitialLoading = (configQuery.isPending || flightsQuery.isPending) && !hasFlights;
  const isEmptyError = flightsQuery.isError && !hasFlights;
  const emptyTitle = isInitialLoading
    ? "Loading flights…"
    : isEmptyError
      ? "Could not load flights."
      : "No flights recorded yet.";
  const emptySubtitle = isInitialLoading
    ? "Waiting for the logbook query to return."
    : isEmptyError
      ? "Check the GraphQL configuration or network connection, or reload to use cached data."
      : "Flights are automatically captured from Microsoft Flight Simulator via SimConnect.";

  return (
    <>
      <Header status={statusQuery.data ?? DEFAULT_STATUS} />
      <ActiveBanner status={statusQuery.data ?? DEFAULT_STATUS} />

      <main className="main-content">
        <Toolbar
          total={flightsPayload?.total ?? flights.length}
          hasError={flightsQuery.isError}
          showingCached={showingCached}
        />

        {hasFlights ? (
          <div className="table-wrapper">
            <table className="logbook-table">
              <thead>
                <tr>
                  <th
                    data-col="date"
                    className={sortClass("date", sortCol, sortDir)}
                    onClick={() => toggleSort("date")}
                  >
                    Date <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="aircraft"
                    className={sortClass("aircraft", sortCol, sortDir)}
                    onClick={() => toggleSort("aircraft")}
                  >
                    Aircraft <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="from"
                    className={sortClass("from", sortCol, sortDir)}
                    onClick={() => toggleSort("from")}
                  >
                    From <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="to"
                    className={sortClass("to", sortCol, sortDir)}
                    onClick={() => toggleSort("to")}
                  >
                    To <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="distance_nm"
                    className={`${sortClass("distance_nm", sortCol, sortDir)} num`}
                    onClick={() => toggleSort("distance_nm")}
                  >
                    Dist (nm) <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="elapsed"
                    className={`${sortClass("elapsed", sortCol, sortDir)} num`}
                    onClick={() => toggleSort("elapsed")}
                  >
                    Duration <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="max_alt"
                    className={`${sortClass("max_alt", sortCol, sortDir)} num`}
                    onClick={() => toggleSort("max_alt")}
                  >
                    Max Alt <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="landing_vs"
                    className={`${sortClass("landing_vs", sortCol, sortDir)} num`}
                    onClick={() => toggleSort("landing_vs")}
                  >
                    Ldg VS <span className="sort-icon"></span>
                  </th>
                  <th
                    data-col="landing_g"
                    className={`${sortClass("landing_g", sortCol, sortDir)} num`}
                    onClick={() => toggleSort("landing_g")}
                  >
                    Ldg G <span className="sort-icon"></span>
                  </th>
                  <th className="actions-col"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((flight) => {
                  const { date, time } = fmtDate(flight.date);
                  const departure = routeLabel(flight, "departure");
                  const arrival = routeLabel(flight, "arrival");
                  const vs = fmtVS(flight.landing_vs_fpm);
                  const aircraft = flight.aircraft_registration || "";
                  const title = flight.aircraft_title || "";
                  const deleting = deleteMutation.isPending
                    && String(deleteMutation.variables) === String(flight.id);

                  return (
                    <tr key={flight.id} onClick={() => setSelectedFlightId(flight.id)}>
                      <td>
                        <span className="date-date">{date}</span>
                        <span className="date-time">{time}</span>
                      </td>
                      <td>
                        {aircraft ? <span className="aircraft-reg">{aircraft}</span> : null}
                        <span className="aircraft-title" title={title || "—"}>
                          {title || "—"}
                        </span>
                      </td>
                      <td><span className="route-from">{departure}</span></td>
                      <td><span className="route-to">{arrival}</span></td>
                      <td className="num hide-sm">{fmtNm(flight.distance_nm)}</td>
                      <td className="num">{fmtDuration(flight.elapsed_seconds)}</td>
                      <td className="num hide-md">{fmtAlt(flight.max_altitude_ft)}</td>
                      <td className="num"><span className={vs.cls}>{vs.text}</span></td>
                      <td className="num hide-md">{fmtG(flight.landing_g_force)}</td>
                      <td className="actions-col">
                        <button
                          className="btn-delete"
                          disabled={deleting}
                          title="Delete this flight"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDelete(flight.id);
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={emptyTitle} subtitle={emptySubtitle} />
        )}
      </main>

      <FlightModal flight={selectedFlight} onClose={() => setSelectedFlightId(null)} />
    </>
  );
}
