import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client'

export function useDeleteFlight() {
  const queryClient = useQueryClient()

  return useMutation<{ deleted: number }, Error, number>({
    mutationFn: (flightId: number) =>
      apiFetch<{ deleted: number }>(`/api/flights/${flightId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flights'] })
    },
  })
}
