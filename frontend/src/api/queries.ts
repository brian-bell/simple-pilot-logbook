import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { StatusResponse, FlightsResponse, Flight } from '../types'

export function useStatus() {
  return useQuery<StatusResponse>({
    queryKey: ['status'],
    queryFn: () => apiFetch<StatusResponse>('/api/status'),
    refetchInterval: 3_000,
    retry: false,
    placeholderData: {
      connected: false,
      state: 'DISCONNECTED' as const,
      current_flight: null,
    },
  })
}

export function useFlights() {
  return useQuery<FlightsResponse>({
    queryKey: ['flights'],
    queryFn: () => apiFetch<FlightsResponse>('/api/flights?limit=200'),
    refetchInterval: 10_000,
  })
}

export function useFlight(id: number | null) {
  return useQuery<Flight>({
    queryKey: ['flight', id],
    queryFn: () => apiFetch<Flight>(`/api/flights/${id}`),
    enabled: id !== null,
  })
}
