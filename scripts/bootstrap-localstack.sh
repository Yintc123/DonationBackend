#!/usr/bin/env bash
#
# Spec 018 §9.3 — bootstrap the local-dev S3 bucket on LocalStack.
#
# Idempotent — re-running is safe:
#   - `s3 mb` failures (bucket already exists) are swallowed.
#   - `put-bucket-policy` / `put-bucket-cors` overwrite the previous value.
#
# Prerequisites:
#   - LocalStack container running on http://localhost:4566 (run
#     `cd ../infra && docker compose up -d` from the backend dir first).
#   - `aws` CLI installed (any version that supports --endpoint-url).
#   - `jq` installed (used to inline-build the policy / cors JSON).
#
# Run once after `docker compose up -d`:
#   ./scripts/bootstrap-localstack.sh
#
# To target a different bucket name (e.g. for an integration-test fixture):
#   BUCKET=my-other-bucket ./scripts/bootstrap-localstack.sh

set -euo pipefail

LS="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
BUCKET="${BUCKET:-local-dev-assets}"

# ── preflight: required CLIs ─────────────────────────────────────────────
# Without these the script will fail mid-way with cryptic errors. Check
# upfront so the user gets one clear install instruction instead of a
# truncated jq stderr line.
missing=()
for cli in aws jq curl; do
  if ! command -v "$cli" >/dev/null 2>&1; then
    missing+=("$cli")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: missing required CLI(s): ${missing[*]}" >&2
  echo "" >&2
  echo "install on macOS (Homebrew):  brew install ${missing[*]}" >&2
  echo "install on Debian/Ubuntu:     sudo apt-get install -y ${missing[*]}" >&2
  exit 1
fi

# ── preflight: LocalStack reachable ──────────────────────────────────────
if ! curl -fsS "${LS}/_localstack/health" >/dev/null 2>&1; then
  echo "error: LocalStack not reachable at ${LS}" >&2
  echo "hint:  cd ../infra && docker compose up -d localstack" >&2
  exit 1
fi

# LocalStack ignores credential contents but the AWS CLI still requires that
# *something* be present in the environment.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-1}"

echo "→ creating bucket ${BUCKET} (idempotent)"
aws --endpoint-url="${LS}" s3 mb "s3://${BUCKET}" 2>/dev/null || true

echo "→ applying public-read bucket policy (spec 018 §6.1)"
aws --endpoint-url="${LS}" s3api put-bucket-policy \
  --bucket "${BUCKET}" \
  --policy "$(jq -n --arg bucket "${BUCKET}" '{
    "Version":"2012-10-17",
    "Statement":[{
      "Sid":"AllowPublicRead",
      "Effect":"Allow",
      "Principal":"*",
      "Action":"s3:GetObject",
      "Resource":"arn:aws:s3:::\($bucket)/*"
    }]
  }')"

echo "→ applying CORS rules (spec 018 §6.3)"
aws --endpoint-url="${LS}" s3api put-bucket-cors \
  --bucket "${BUCKET}" \
  --cors-configuration "$(jq -n '{
    "CORSRules":[{
      "AllowedOrigins":["http://localhost:3000"],
      "AllowedMethods":["PUT","GET","HEAD"],
      "AllowedHeaders":["*"],
      "ExposeHeaders":["ETag"],
      "MaxAgeSeconds":3600
    }]
  }')"

echo "✓ bucket ${BUCKET} ready at ${LS}/${BUCKET}"
