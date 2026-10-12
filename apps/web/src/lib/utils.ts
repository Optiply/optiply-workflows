import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return 'Never'
  const seconds = (new Date(value).getTime() - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}
