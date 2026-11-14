// The watchlist: markets you starred, kept in this browser only (a per-viewer convenience, like Polymarket's
// bookmarks). Storage may be blocked, so every read and write is guarded and the list starts empty then.
import { useSyncExternalStore } from 'react'

const KEY = 'ov-watch'
let list: string[] = []
let loaded = false
const subs = new Set<() => void>()
const load = () => {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try { list = JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { list = [] }
}
const EMPTY: string[] = []

export function toggleWatch(id: string) {
  load()
  list = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* kept for this visit only */ }
  subs.forEach((f) => f())
}

export const useWatch = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f) } },
  () => { load(); return list },
  () => EMPTY,
)

/** Days from today to a human date like "9 Dec 2026"; null when it isn't a date. */
export function daysLeft(d: string, now = Date.now()) {
  const t = Date.parse(d)
  return Number.isNaN(t) ? null : Math.ceil((t - now) / 86_400_000)
}
