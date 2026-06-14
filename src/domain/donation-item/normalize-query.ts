// Spec 016 §4.2 v0.13 — `q` ingest normalisation.
//
// Two distinct inputs from different IMEs / OSes can render identically yet
// hold different Unicode code-point sequences (NFC vs NFD). Postgres ILIKE
// compares byte-for-byte under the hood, so without normalising at the
// boundary, "façade" (one codepoint) and "façade" (two — c + combining
// cedilla) would never match each other. We pin everything to NFC on the
// way in.
//
// Order: normalise FIRST, trim AFTER. If we trim first, an input like
// `"  é  "` would trim correctly but then the surviving `"é"`
// is not NFC; ILIKE would miss rows stored with the precomposed `"é"`.
//
// Empty after normalise+trim is treated as "no `q` supplied" — matching
// spec 016 §4.2 + §5.2 "q 為空字串 / 全空白 → trim 後等價於未傳 → 不過濾".

export function normalizeQuery(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const normalised = raw.normalize('NFC').trim()
  return normalised.length === 0 ? undefined : normalised
}
