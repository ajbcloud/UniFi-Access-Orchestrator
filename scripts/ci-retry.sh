#!/usr/bin/env bash
# Retry a command with linear backoff. Used in CI to ride out transient network
# failures (most often an Electron binary download returning 504 during
# `npm ci` or `electron-builder`) instead of failing the whole build.
#
# Usage: bash scripts/ci-retry.sh <command> [args...]
#   CI_RETRY_MAX  max attempts (default 5)
#   CI_RETRY_BASE base backoff seconds, multiplied by attempt number (default 15)
set -u

max="${CI_RETRY_MAX:-5}"
base="${CI_RETRY_BASE:-15}"

if [ "$#" -eq 0 ]; then
  echo "ci-retry: no command given" >&2
  exit 2
fi

attempt=1
while true; do
  "$@" && exit 0
  status=$?
  if [ "$attempt" -ge "$max" ]; then
    echo "ci-retry: '$*' failed after ${attempt} attempts (last exit ${status})" >&2
    exit "$status"
  fi
  delay=$((attempt * base))
  echo "ci-retry: '$*' failed (attempt ${attempt}/${max}, exit ${status}); retrying in ${delay}s..." >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
