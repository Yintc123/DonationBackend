// Spec 022 §5.2 — Order field normalisation shared between create-service
// (public POST endpoints) and admin patch service.
//
// `normalizeNote`:
//   - undefined → undefined (PATCH "leave alone" semantic)
//   - null      → null      (PATCH "clear" semantic)
//   - ""        → null      (treat empty / whitespace-only as no note)
//   - "  x  "   → "x"       (trim surrounding whitespace)
//
// Centralised here so any future caller (CLI / batch fix / a second admin
// route) cannot drift from the create / admin-PATCH contract.

export function normalizeNote(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}
