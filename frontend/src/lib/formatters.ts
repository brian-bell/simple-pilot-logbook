import type { Flight } from '../types'

export function fmtDuration(secs: number | null | undefined): string {
  if (secs == null) return '\u2014'
  secs = Math.round(secs)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export function fmtVS(fpm: number | null | undefined): { text: string; cls: string } {
  if (fpm == null) return { text: '\u2014', cls: '' }
  const abs = Math.abs(fpm)
  const text = `${Math.round(fpm)} fpm`
  if (abs <= 200) return { text, cls: 'text-green' }
  if (abs <= 400) return { text, cls: 'text-yellow' }
  return { text, cls: 'text-red font-semibold' }
}

export function fmtG(g: number | null | undefined): string {
  if (g == null) return '\u2014'
  return g.toFixed(2) + ' G'
}

export function fmtNm(nm: number | null | undefined): string {
  if (nm == null) return '\u2014'
  return nm.toFixed(1)
}

export function fmtAlt(ft: number | null | undefined): string {
  if (ft == null) return '\u2014'
  return Math.round(ft).toLocaleString() + ' ft'
}

export function fmtDate(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '\u2014', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: iso.slice(0, 10), time: '' }
  return {
    date: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }
}

export function routeLabel(flight: Flight, which: 'departure' | 'arrival'): string {
  const icao = flight[`${which}_icao`]
  const lat = flight[`${which}_lat`]
  const lon = flight[`${which}_lon`]
  if (icao) return icao
  if (lat != null && lon != null) {
    const ns = lat >= 0 ? 'N' : 'S'
    const ew = lon >= 0 ? 'E' : 'W'
    return `${ns}${Math.abs(lat).toFixed(1)} ${ew}${Math.abs(lon).toFixed(1)}`
  }
  return '\u2014'
}
