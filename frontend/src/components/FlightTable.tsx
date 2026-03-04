import { useState, useMemo, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import type { Flight } from '../types'
import { fmtDuration, fmtVS, fmtG, fmtNm, fmtAlt, fmtDate, routeLabel } from '../lib/formatters'
import { useDeleteFlight } from '../api/mutations'

interface Props {
  flights: Flight[]
  onSelectFlight: (flight: Flight) => void
}

const columnHelper = createColumnHelper<Flight>()

export function FlightTable({ flights, onSelectFlight }: Props) {
  const deleteMutation = useDeleteFlight()

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'date', desc: true },
  ])

  const columns = useMemo(
    () => [
      columnHelper.accessor('date', {
        header: 'Date',
        cell: (info) => {
          const { date, time } = fmtDate(info.getValue())
          return (
            <div>
              <span className="block font-mono text-xs">{date}</span>
              <span className="block font-mono text-[11px] text-text-muted">{time}</span>
            </div>
          )
        },
        sortingFn: 'alphanumeric',
      }),
      columnHelper.display({
        id: 'aircraft',
        header: 'Aircraft',
        cell: ({ row }) => {
          const reg = row.original.aircraft_registration || ''
          const title = row.original.aircraft_title || ''
          return (
            <div>
              {reg && <span className="font-mono text-[11px] text-text-muted">{reg}</span>}
              <span
                className="block text-xs text-text-dim max-w-[160px] overflow-hidden text-ellipsis"
                title={title}
              >
                {title || '\u2014'}
              </span>
            </div>
          )
        },
        sortingFn: (rowA, rowB) => {
          const a = rowA.original.aircraft_registration || rowA.original.aircraft_title || ''
          const b = rowB.original.aircraft_registration || rowB.original.aircraft_title || ''
          return a.localeCompare(b)
        },
      }),
      columnHelper.display({
        id: 'from',
        header: 'From',
        cell: ({ row }) => (
          <span className="font-mono text-text-primary">
            {routeLabel(row.original, 'departure')}
          </span>
        ),
        sortingFn: (rowA, rowB) =>
          (rowA.original.departure_icao || '').localeCompare(rowB.original.departure_icao || ''),
      }),
      columnHelper.display({
        id: 'to',
        header: 'To',
        cell: ({ row }) => (
          <span className="font-mono text-text-primary">
            {routeLabel(row.original, 'arrival')}
          </span>
        ),
        sortingFn: (rowA, rowB) =>
          (rowA.original.arrival_icao || '').localeCompare(rowB.original.arrival_icao || ''),
      }),
      columnHelper.accessor('distance_nm', {
        header: 'Dist (nm)',
        cell: (info) => fmtNm(info.getValue()),
        meta: { isNumeric: true, hideClass: 'hidden sm:table-cell' },
      }),
      columnHelper.accessor('elapsed_seconds', {
        id: 'elapsed',
        header: 'Duration',
        cell: (info) => fmtDuration(info.getValue()),
        meta: { isNumeric: true },
      }),
      columnHelper.accessor('max_altitude_ft', {
        id: 'max_alt',
        header: 'Max Alt',
        cell: (info) => fmtAlt(info.getValue()),
        meta: { isNumeric: true, hideClass: 'hidden md:table-cell' },
      }),
      columnHelper.accessor('landing_vs_fpm', {
        id: 'landing_vs',
        header: 'Ldg VS',
        cell: (info) => {
          const vs = fmtVS(info.getValue())
          return <span className={vs.cls}>{vs.text}</span>
        },
        meta: { isNumeric: true },
      }),
      columnHelper.accessor('landing_g_force', {
        id: 'landing_g',
        header: 'Ldg G',
        cell: (info) => fmtG(info.getValue()),
        meta: { isNumeric: true, hideClass: 'hidden md:table-cell' },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <button
            className="bg-transparent border border-border-light text-text-muted cursor-pointer py-0.5 px-2 text-[11px] transition-colors hover:border-red hover:text-red"
            title="Delete this flight"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm('Delete this flight entry?')) {
                deleteMutation.mutate(row.original.id)
              }
            }}
          >
            &#10005;
          </button>
        ),
        meta: { isActions: true },
      }),
    ],
    [deleteMutation],
  )

  const table = useReactTable({
    data: flights,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const handleRowClick = useCallback(
    (flight: Flight) => onSelectFlight(flight),
    [onSelectFlight],
  )

  return (
    <div className="w-full overflow-x-auto border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-surface border-b border-border">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const meta = header.column.columnDef.meta as
                  | { isNumeric?: boolean; hideClass?: string; isActions?: boolean }
                  | undefined

                return (
                  <th
                    key={header.id}
                    className={`
                      px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider
                      text-text-muted border-r border-border whitespace-nowrap select-none
                      last:border-r-0
                      ${meta?.isNumeric ? 'text-right' : ''}
                      ${meta?.hideClass || ''}
                      ${canSort ? 'cursor-pointer hover:bg-surface-alt hover:text-text-primary' : ''}
                    `}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted === 'asc' && ' \u25B2'}
                    {sorted === 'desc' && ' \u25BC'}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-border transition-colors cursor-pointer even:bg-surface-alt hover:bg-surface-hover"
              onClick={() => handleRowClick(row.original)}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as
                  | { isNumeric?: boolean; hideClass?: string; isActions?: boolean }
                  | undefined

                return (
                  <td
                    key={cell.id}
                    className={`
                      px-3.5 py-2.5 border-r border-border align-middle whitespace-nowrap
                      last:border-r-0
                      ${meta?.isNumeric ? 'text-right font-mono text-xs' : ''}
                      ${meta?.hideClass || ''}
                    `}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
