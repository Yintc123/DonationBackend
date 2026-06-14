// Backend ADR 004 / spec 016 §4.1.1 — Accept-Language parsing and field
// selection.
//
// Supported locales:
//   - `zh-TW` — default (master language; non-nullable in DB)
//   - `en`    — secondary (nullable; falls back to zh-TW)
//
// Parsing rules:
//   - Empty / missing header → 'zh-TW'
//   - Quality values (`;q=`) honored; q=0 means "rejected"
//   - Ties broken by header order (first wins)
//   - Subtag matching: `en-US` → en; `zh-Hant-TW`, `zh-TW` → zh-TW
//   - `zh` without Hant/TW → zh-TW (we treat Traditional as our zh)

export const LOCALES = ['zh-TW', 'en'] as const
export type Locale = (typeof LOCALES)[number]

const DEFAULT_LOCALE: Locale = 'zh-TW'

interface ParsedEntry {
  locale: Locale
  q: number
  /** Position in the original header — earlier wins ties. */
  order: number
}

function matchLocale(tag: string): Locale | undefined {
  const t = tag.trim().toLowerCase()
  if (!t) return undefined
  // English family.
  if (t === 'en' || t.startsWith('en-')) return 'en'
  // Chinese family — we treat all zh variants as zh-TW (Traditional).
  if (t === 'zh' || t.startsWith('zh')) return 'zh-TW'
  return undefined
}

export function parseAcceptLanguage(header: string | undefined): Locale {
  if (!header) return DEFAULT_LOCALE

  const parsed: ParsedEntry[] = []
  const parts = header.split(',')
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (!part) continue
    const [tagRaw, ...params] = part.split(';')
    const tag = (tagRaw ?? '').trim()
    const locale = matchLocale(tag)
    if (!locale) continue

    let q = 1
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)
      if (!m) continue
      const numeric = Number(m[1])
      if (!Number.isFinite(numeric)) continue
      q = numeric
      break
    }
    if (q <= 0) continue

    parsed.push({ locale, q, order: i })
  }

  if (parsed.length === 0) return DEFAULT_LOCALE

  parsed.sort((a, b) => {
    if (a.q !== b.q) return b.q - a.q
    return a.order - b.order
  })
  return parsed[0]!.locale
}

export interface LocalisedFields {
  zh: string
  en: string | null | undefined
}

export function pickLocalised(locale: Locale, fields: LocalisedFields): string {
  if (locale === 'en' && fields.en !== null && fields.en !== undefined) {
    return fields.en
  }
  return fields.zh
}
