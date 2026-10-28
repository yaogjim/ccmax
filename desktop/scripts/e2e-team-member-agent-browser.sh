#!/usr/bin/env bash
# Team member tab smoke (REL-003 / S1.3) and artifact review smoke (S3.3):
# drives the real desktop member tab and the real task drawer against the real
# server and a scripted member runtime.
#
# S1.3 asserts that a typed interjection keeps the same message id from the
# pending bubble through the mailbox echo, that the echo settles exactly that
# bubble, that two identical sends stay two sends, and that a reload replays the
# same order.
#
# S3.3 asserts that the delivery panel in the task drawer drives the real
# protocol: it returns the seeded artifact v1 only after a reason is supplied,
# the owner then publishes v2 through the production delivery action rather than
# the UI, the browser accepts v2, and a reload replays both decisions. An
# archived team's snapshot renders read-only, and a member seeded with
# initialStartPending renders as standby. A task seeded with a delivery schema
# newer than this server's states its read-only reason, offers no review action,
# leaks nothing from the raw record, and is never rewritten on disk.
#
# No provider, no credentials, no network, no real team: the run uses a
# throwaway HOME plus CLAUDE_CONFIG_DIR, a fake provider pointed at a closed
# port, and synthetic team/transcript/task files.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is required but was not found in PATH" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH" >&2
  exit 1
fi

ARTIFACT_DIR="${E2E_TEAM_MEMBER_ARTIFACT_DIR:-$(mktemp -d "/tmp/e2e-team-member-$(date +%s)-XXXX")}"
mkdir -p "${ARTIFACT_DIR}"

E2E_TEAM_MEMBER_ARTIFACT_DIR="${ARTIFACT_DIR}" \
E2E_TEAM_MEMBER_ROOT="${ROOT_DIR}" \
  bun "${ROOT_DIR}/desktop/scripts/fixtures/e2e-team-member/drive.ts" --artifact-dir "${ARTIFACT_DIR}" || exit_code=$?

if [[ ${exit_code:-0} -ne 0 ]]; then
  echo "Artifacts kept at: ${ARTIFACT_DIR}" >&2
fi

exit ${exit_code:-0}