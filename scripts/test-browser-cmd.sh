#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CMD="$PROJECT_DIR/scripts/browser-cmd.sh"

pass() {
  printf '[PASS] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

run_with_retry() {
  local attempts="$1"
  shift

  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if "$@"; then
      return 0
    fi
    if [[ "$i" -lt "$attempts" ]]; then
      sleep 1
    fi
  done

  return 1
}

require_cmd node
require_cmd curl
[[ -x "$CMD" ]] || fail "Command wrapper not executable: $CMD"

cd "$PROJECT_DIR"

CDP_CHECK_URL="${BROWSER_CDP_URL:-http://127.0.0.1:${BROWSER_CDP_PORT:-19222}}/json/version"

printf '[INFO] Running browser-cmd integration checks\n'

# 0) Wait for CDP endpoint readiness (container may still be starting)
if ! run_with_retry 120 curl -s --max-time 2 "$CDP_CHECK_URL" >/tmp/browser-cmd-cdp-version.json 2>/tmp/browser-cmd-cdp-version.err; then
  cat /tmp/browser-cmd-cdp-version.err >&2 || true
  fail "CDP endpoint is not ready at $CDP_CHECK_URL"
fi
pass "CDP endpoint is reachable"

# 1) tabs must succeed and return short IDs (<=5 chars)
if ! run_with_retry 5 "$CMD" tabs >/tmp/browser-cmd-tabs.json 2>/tmp/browser-cmd-tabs.err; then
  cat /tmp/browser-cmd-tabs.err >&2 || true
  fail "browser-cmd tabs failed after retries"
fi

node <<'NODE' || fail "tabs output is invalid"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-tabs.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
  process.exit(1);
}
for (const tab of parsed.tabs) {
  if (typeof tab.id !== 'string' || tab.id.length === 0 || tab.id.length > 5) {
    process.exit(1);
  }
  if (typeof tab.title !== 'string' || typeof tab.url !== 'string') {
    process.exit(1);
  }
}
NODE
pass "tabs returns short IDs with minimal tab info"

TAB_ID="$(
  node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/tmp/browser-cmd-tabs.json','utf8'));process.stdout.write(j.tabs[0].id);"
)"
[[ -n "$TAB_ID" ]] || fail "Unable to read TAB_ID from tabs output"

# 2) state without --tab must fail with exit code 2 and guidance payload
set +e
"$CMD" state >/tmp/browser-cmd-state-missing.json 2>/tmp/browser-cmd-state-missing.err
STATE_NO_TAB_EXIT=$?
set -e

[[ "$STATE_NO_TAB_EXIT" -eq 2 ]] || fail "state without --tab must exit 2 (got $STATE_NO_TAB_EXIT)"

node <<'NODE' || fail "state without --tab did not return guidance payload"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-state-missing.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || typeof parsed.message !== 'string') process.exit(1);
if (!parsed.message.includes('Pass --tab <id>')) process.exit(1);
if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) process.exit(1);
for (const tab of parsed.tabs) {
  if (typeof tab.id !== 'string' || tab.id.length === 0 || tab.id.length > 5) process.exit(1);
}
NODE
pass "state without --tab returns guidance + short tab IDs"

# 3) state with short --tab must succeed and return simple structured state
if ! run_with_retry 5 "$CMD" state --tab "$TAB_ID" >/tmp/browser-cmd-state.json 2>/tmp/browser-cmd-state.err; then
  cat /tmp/browser-cmd-state.err >&2 || true
  fail "state with --tab $TAB_ID failed after retries"
fi

node <<'NODE' || fail "state --tab output is invalid"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-state.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || typeof parsed !== 'object') {
  process.exit(1);
}
if (!parsed.meta || typeof parsed.meta.url !== 'string' || typeof parsed.meta.title !== 'string') {
  process.exit(1);
}
if (!parsed.meta.viewport || typeof parsed.meta.viewport.w !== 'number' || typeof parsed.meta.viewport.h !== 'number') {
  process.exit(1);
}
if (!parsed.tree || !Array.isArray(parsed.tree.children)) {
  process.exit(1);
}

const walk = (nodes) => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') process.exit(1);
    if (Object.prototype.hasOwnProperty.call(node, 'sectionId')) {
      if (typeof node.sectionId !== 'string' || node.sectionId.length === 0) process.exit(1);
      if (Array.isArray(node.children)) {
        if (typeof node.tag !== 'string' || node.tag.length === 0) process.exit(1);
        walk(node.children);
        continue;
      }
      if (!Array.isArray(node.label)) process.exit(1);
      if (typeof node.tag !== 'string' || node.tag.length === 0) process.exit(1);
      continue;
    }
    if (Array.isArray(node.children)) {
      walk(node.children);
      continue;
    }
    if (!Array.isArray(node.label)) process.exit(1);
    if (Object.prototype.hasOwnProperty.call(node, 'id')) {
      if (typeof node.id !== 'string' || node.id.length === 0) process.exit(1);
    } else {
      if (typeof node.sectionId !== 'string' || node.sectionId.length === 0) process.exit(1);
      if (typeof node.tag !== 'string' || node.tag.length === 0) process.exit(1);
    }
  }
};

walk(parsed.tree.children);
NODE
pass "state with short --tab works"

# 4) query must return structured selector output
if ! run_with_retry 5 "$CMD" query html tag --tab "$TAB_ID" >/tmp/browser-cmd-query.json 2>/tmp/browser-cmd-query.err; then
  cat /tmp/browser-cmd-query.err >&2 || true
  fail "query command failed"
fi

node <<'NODE' || fail "query output is invalid"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-query.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || typeof parsed !== 'object') process.exit(1);
if (typeof parsed.selector !== 'string' || typeof parsed.value !== 'string') process.exit(1);
if (parsed.value.toLowerCase() !== 'html') process.exit(1);
NODE
pass "query returns structured extraction output"

# 5) state --flat must include raw arrays + simple payload
if ! run_with_retry 5 "$CMD" state --flat --tab "$TAB_ID" >/tmp/browser-cmd-state-flat.json 2>/tmp/browser-cmd-state-flat.err; then
  cat /tmp/browser-cmd-state-flat.err >&2 || true
  fail "state --flat command failed"
fi

node <<'NODE' || fail "state --flat output is invalid"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-state-flat.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || typeof parsed !== 'object') process.exit(1);
if (!parsed.nested || !parsed.nested.meta || !parsed.nested.tree) process.exit(1);
if (!Array.isArray(parsed.clickable) || !Array.isArray(parsed.inputs)) process.exit(1);
NODE
pass "state --flat returns raw arrays and nested payload"

# 6) --agent output must be compact JSON (single-line object)
if ! run_with_retry 5 "$CMD" --agent tabs >/tmp/browser-cmd-agent-tabs.json 2>/tmp/browser-cmd-agent-tabs.err; then
  cat /tmp/browser-cmd-agent-tabs.err >&2 || true
  fail "--agent tabs failed"
fi

node <<'NODE' || fail "--agent tabs output is invalid"
const fs = require('fs');
const raw = fs.readFileSync('/tmp/browser-cmd-agent-tabs.json', 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || !Array.isArray(parsed.tabs)) process.exit(1);
if (raw.includes('\n') && raw.trim().split('\n').length > 1) process.exit(1);
NODE
pass "--agent uses compact machine-friendly JSON"

printf '[INFO] All checks passed\n'
