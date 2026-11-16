#!/usr/bin/env bash
# CLI/server checks for claims 12, 13 and 18 against the real appium entry point.
# Run from the repo root after `npm ci && npx tsc -b`.
set -u
export APPIUM_HOME="$(mktemp -d)"
A="node packages/appium/index.js"

echo "--- #12 --port 4723abc (expected: rejected; observed: listens on 4723)"
timeout 12 $A --port 4723abc > /tmp/qa-e2e-port.log 2>&1 &
sleep 8
curl -s -m 3 http://127.0.0.1:4723/status; echo
grep -E "listener started" /tmp/qa-e2e-port.log
wait

echo "--- #18 --webhook '[::1]:9003' (rejected by format:uri before parseWebhookUri runs)"
timeout 10 $A --webhook '[::1]:9003' 2>&1 | grep -E "error"

echo "--- #13 inline --log-filters with a comma"
timeout 10 $A --log-filters '[{"text":"password","replacer":"***"}]' 2>&1 | grep -E "error"
