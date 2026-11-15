# Appium upstream master QA audit

**Audited commit:** `a8d646b6ccbe61335618bfdc039fd2050b7c9194`  
**Subject:** `fix(support): apply case-only moves on macOS too (#23147)`  
**Date:** 2026-11-15 23:10:01 +0100  
**Remote:** `https://github.com/appium/appium.git` branch `master`

The fork `Mochxd/appium` master (`33459705e`, 2026-08-14) is 460 commits behind this commit. Every finding below was re-checked on `a8d646b6c`. Suspects that this commit already fixes are listed separately and are not counted as bugs.

No product code was changed. Evidence is two scripts that import the compiled packages and print `REPRODUCED` for each case: `qa-repro/reproduce-bugs.mjs` (`7/7`) and `qa-repro/followup-repros.mjs` (`12/12`) on this commit.

```bash
npm ci
npx tsc -b
node qa-repro/reproduce-bugs.mjs
node qa-repro/followup-repros.mjs
```

Upstream issue search (GitHub issues on `appium/appium`, plus issue `#18716`) did not find an open report that describes these defects. `#18716` is closed and is about `json-schema-to-typescript` emitting the wrong TypeScript type for `ipv6`, which is a different problem.

---

## ChaosEngine

The URL requested in the task, `https://raw.githubusercontent.com/ShaftHQ/SHAFT_ENGINE/main/chaos-engine/bootstrap.py`, returns **HTTP 404**. `chaos-engine/README.md` on `ShaftHQ/SHAFT_ENGINE` `main` says ChaosEngine moved to `ShaftHQ/chaosengine-harness`, and `chaos-engine/install.sh` is only a forwarder.

Install used the current bootstrap (`https://raw.githubusercontent.com/ShaftHQ/chaosengine-harness/main/bootstrap.py`) after reading it:

```bash
CHAOS_ENGINE_HOST=cursor python3 bootstrap.py \
  --project . \
  --repository ShaftHQ/chaosengine-harness \
  --branch main \
  --hosts cursor \
  --yes \
  --consumer \
  --no-auto-addons \
  --no-color
```

`--repository ShaftHQ/SHAFT_ENGINE` was not used. That tree no longer contains the harness (`INSTALL.md` says not to point `--source` at it).

`python3 .chaos-engine/install.py status --project .` reported **ChaosEngine status: healthy**, core commit `588396008f0679dafaba5d1fbab15965f2c78bdb`, with **graphify degraded** (`stale - shared Graphify cache has no indexed revision marker`, task impact `required-when-indexed`). Completion target recorded: `cursor`. `.cursor/hooks.json` was written. Doctor during install: 18/19 healthy.

`python3 .chaos-engine/tool.py retrieve --store graphify "session capability parsing and proxy timeout bugs"` returned `skipped` (`no-rare-token`, stale graph, zero hits). There is no project index, so retrieval did not replace source reads. The lean rule did keep later reads to the suspect functions instead of another full-tree pass. The install itself downloaded the harness and provisioned Node, Python, Java, uv, MemPalace, and Graphify, which cost more setup than the skipped retrieve saved. ChaosEngine files (`.chaos-engine/`, `.cursor/hooks.json`, `entities.json`, and the MemPalace `.gitignore` fragment) were left uncommitted. `.git/info/exclude` from `--consumer` hides the overlay.

`retrieve: skipped(graphify stale, no project index)`

---

## Confirmed bugs

### 1. Cancelling a proxied request hangs the caller forever

| | |
| --- | --- |
| Severity | **High** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/wd-proxy/proxy-request.ts:45-48` (invoked by `cancelActiveRequests` at `packages/base-driver/lib/wd-proxy/proxy.ts:113-117`) |

`ProxyRequest.cancel()` aborts the Axios call, then on `axios.isCancel` returns `new Promise(() => {})`. That promise never settles. `WebDriverProxy.request()` awaits `execute()`, so its `finally` (which drops the request from `_activeRequests`) never runs. `cancelActiveRequests()` replaces the array, but every in-flight `proxy()` / `command()` / `proxyReqRes()` stays pending.

**Reproduction:** `node qa-repro/reproduce-bugs.mjs` (case `ProxyRequest.cancel() never settles the in-flight request`). A local HTTP server never responds; `execute()` is started; `cancel()` is called; after 1s the promise is still pending.

**Expected:** the awaited proxy call rejects with a cancellation error so session teardown can finish.  
**Actual:** `execute()` hung.

**Fix direction:** reject with the cancellation error (or a dedicated `ProxyRequestError`) instead of returning a forever-pending promise. Callers that want to ignore cancellation can catch that error. Do not swallow it by awaiting a promise that has no resolver.

No in-repo caller other than `cancelActiveRequests` itself. The method is the public cancellation API on `WebDriverProxy`. A code search of `appium/appium-uiautomator2-driver` for the name returned no hits (the driver may call it under a different revision or wrapper). The hang is still reachable by any driver that cancels an in-flight proxied command and then awaits it.

### 2. An idempotency key does not pin the request

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/protocol/idempotency.ts:69-81` |

The middleware keys only on the header value, then compares `method` and `path`.

- Same key, different path: it logs a warning and calls `next()`, so the second POST runs.
- Same key and path, different body: it replays the first response and does not run the handler.

There is no body fingerprint and no 422. The cache is process-wide (`IDEMPOTENT_RESPONSES`, max 64, TTL 30 minutes), so two clients that reuse a key share one entry.

**Reproduction:** same script, case `Reused idempotency key on a different path still runs the handler`.

Concrete input:

1. `POST /session` with `x-idempotency-key: same-key` and body `{capabilities:{alwaysMatch:{browserName:'a'}}}`.
2. `POST /other` with the same key. `next()` runs.
3. `POST /session` with the same key and body `{capabilities:{alwaysMatch:{browserName:'different'}}}`. The handler is not called; the cached bytes are written to the socket.

**Expected:** a key reused with a different method, path, or body is rejected (422) and the new command is not executed. A true retry of the same request replays the first response.  
**Actual:** a different path executes; a different body on the same path is answered with the first response.

**Fix direction:** store a hash of method, path, and the raw body with the key. On mismatch, delete nothing, respond 422, and do not call `next()`. Partition keys by a connection or client identity if keys are not globally unique.

### 3. Log-filter replacement strings reinsert the secret

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/logger` |
| Location | `packages/logger/lib/secure-values-preprocessor.ts:124-126` |

`preprocess` does `result.replace(rule.pattern, rule.replacer)`. `String.prototype.replace` treats `$&`, `` $` ``, `$'`, `$1`…`$9`, and `$$` as substitution patterns. The default replacer `**SECURE**` has no `$` and is safe. A custom `replacer` is not.

**Reproduction:** same script, case `Log filter replacer treats $& as the matched secret`.

```js
loadRules([{text: 's3cret-token', replacer: '[$&]'}])
preprocess('Authorization: Bearer s3cret-token')
// actual: 'Authorization: Bearer [s3cret-token]'
```

**Expected:** the matched secret is replaced by the literal characters `[$&]`.  
**Actual:** `$&` is replaced by the secret, so the log line still contains `s3cret-token`.

The same mechanism leaks with `$'` (text after the match) and `` $` `` (text before the match).

**Fix direction:** pass a function replacer, `() => rule.replacer`, so `$` is literal. Apply that in `preprocess`, not only for the default mask.

### 4. New-session proxying drops the downstream session id when the URL is not exactly `…/session`

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/wd-proxy/proxy.ts:219-220` |

Session capture is `url.endsWith('/session') && method === 'POST'`. The id is then read from `data.value.sessionId` only when that is true. `_toNormalizedPathname` already strips a trailing slash before building the downstream URL, so the command is proxied correctly and the id is still discarded.

**Reproduction:** same script, case `New-session proxy ignores query string and trailing slash when storing sessionId`.

| Request URL | Downstream URL actually used | `proxy.sessionId` after HTTP 200 |
| --- | --- | --- |
| `POST /session?trace=1` | `http://127.0.0.1:9/session?trace=1` | `null` |
| `POST /session/` | `http://127.0.0.1:9/session` | `null` |

A following command that needs a session then throws `Session ID is not set` from `getUrlForProxy`.

**Expected:** `POST` to the new-session route stores `value.sessionId` whether or not the incoming URL has a query string or a trailing slash.  
**Actual:** both forms leave `sessionId` null. `POST /session` (no query, no extra slash) still works; the existing unit test only covers that form.

**Fix direction:** decide “this is new session” from the parsed pathname (`/session` with optional trailing slash), not from `String.prototype.endsWith` on the raw URL.

### 5. Proxied legacy timeouts rewrite `command` into a W3C field the downstream server does not define

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/wd-proxy/proxy.ts:351-358` (`getTimeoutsRequestBody`, used at line 237) |

A body `{type, ms}` is rewritten to `{[type]: ms}`, with only `page load` renamed to `pageLoad`. `type: 'command'` becomes `{command: 60000}`. `command` is the Appium new-command timeout, not a W3C timeout (`script`, `pageLoad`, `implicit`). A downstream W3C server will reject or ignore it, and the proxy path does not apply it locally either.

**Reproduction:** same script, case `Proxied legacy command timeout is rewritten to a non-W3C key`. `getTimeoutsRequestBody({type:'command', ms:60000})` returns `{command:60000}`.

**Expected:** `command` stays on the Appium driver (`setNewCommandTimeout`). Only `implicit`, `script`, and `page load` are reshaped for the downstream server.  
**Actual:** the legacy command timeout is forwarded under an unknown JSON key.

**Fix direction:** when `type === 'command'`, do not put `command` in the downstream body. Handle it in the local driver before proxying, and forward only the W3C keys.

### 6. `parseTimeoutArgument` accepts non-integers

| | |
| --- | --- |
| Severity | **Low** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/basedriver/commands/timeout.ts:203-208` |

`parseInt(String(ms), 10)` stops at the first non-digit. Callers are the deprecated `{type, ms}` timeouts path (lines 49-56) and the Appium `command` timeout (line 72). W3C `script`, `pageLoad`, and `implicit` go through `validateTimeoutValue` in `packages/base-driver/lib/basedriver/helpers/timeouts.ts:36-41` and correctly reject non-integers. This bug is only the legacy parser and the `command` extension.

**Reproduction:** same script, case `parseTimeoutArgument accepts trailing junk, hex-looking strings, and truncates floats`.

| Input | Actual | Notes |
| --- | --- | --- |
| `'10abc'` | `10` | trailing junk kept |
| `'0x10'` | `0` | looks like hex, becomes a zero timeout |
| `10.9` | `10` | fractional milliseconds truncated |

**Expected:** reject any value that is not a non-negative safe integer, same rule as `validateTimeoutValue`.  
**Actual:** the three inputs above are accepted.

**Fix direction:** reuse `validateTimeoutValue` (or a strict `/^(0|[1-9]\d*)$/` check for strings) inside `parseTimeoutArgument`.

### 7. BiDi “missing params” error drops the closing quote

| | |
| --- | --- |
| Severity | **Low** |
| Package | `appium` |
| Location | `packages/appium/lib/bidi/commands.ts:149-150` |

The template is `` `Missing params for BiDi operation in '${dataTruncated}` ``. The matching “missing method” message on line 147 closes the quote. This one does not. Omitting `params` is correctly rejected; the text is wrong.

**Reproduction:** same script, case `BiDi missing-params error omits the closing quote`.

Input message: `{"id":7,"method":"session.status"}` (no `params`).

**Expected:** `Missing params for BiDi operation in '{"id":7,"method":"session.status"}'`  
**Actual:** `Missing params for BiDi operation in '{"id":7,"method":"session.status"}` (no final `'`).

**Fix direction:** close the quote the same way line 147 does.

---

## Additional bugs confirmed on the same commit

These were checked after the first pass. Each one is reproduced by `node qa-repro/followup-repros.mjs`.

### 8. One bad `firstMatch` candidate rejects the whole new session

| | |
| --- | --- |
| Severity | **High** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/basedriver/capabilities.ts:346-347` and `:51-58` |

`CapabilityParser.parse` merges every candidate with `candidates.map((candidate) => mergeCaps(...))` before the `try/catch` in `matchCandidates`. `mergeCaps` throws when a name exists on both `alwaysMatch` and that candidate, including when the values are equal. WebDriver processing is supposed to drop that candidate and try the next one.

**Input:**

```json
{
  "alwaysMatch": {"platformName": "Android"},
  "firstMatch": [
    {"platformName": "Android", "appium:deviceName": "bad"},
    {"appium:deviceName": "emu"}
  ]
}
```

**Expected:** the first candidate is skipped and the match is `platformName=Android`, `deviceName=emu`.  
**Actual:** `invalid argument`: `property 'platformName' should not exist on both primary and secondary`.

The same fail-fast happens in `validateValues` (`capabilities.ts:406-408`): a type error on candidate 0 throws before candidate 1 is considered.

**Fix direction:** catch merge and validation errors per candidate, record them, and continue. Only fail the request when no candidate matches.

### 9. `implicit: null` makes element search wait forever

| | |
| --- | --- |
| Severity | **High** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/basedriver/helpers/timeouts.ts:36-40` and `packages/base-driver/lib/basedriver/commands/timeout.ts:104-105`, `:189-190` |

`validateTimeoutValue` allows `null` for every timeout, including `implicit`. `setImplicitWait` stores that `null` (its comment says null disables the wait). `implicitWaitForCondition` then uses `this.implicitWaitMs ?? Infinity`, and `null ?? Infinity` is `Infinity`. Each poll also clears the new-command timer.

**Input:** `POST /session/:id/timeouts` with `{"implicit": null}`, then find an element that is absent.  
**Expected:** HTTP 400, or one immediate find. The WebDriver spec allows `null` only for `script` and `pageLoad`.  
**Actual:** `implicitWaitMs` is `null` and the find wait is `Infinity`. The log line is `Set implicit wait to nullms`.

**Fix direction:** reject `null` for `implicit`. For `script` and `pageLoad`, keep `null` as "no limit" without routing it through `?? Infinity` on the find path.

### 10. `defaultsDeep` copies a JSON `__proto__` object onto `Object.prototype`

| | |
| --- | --- |
| Severity | **High** |
| Package | `appium` |
| Location | `packages/appium/lib/utils/object.ts:291-299`, called from `packages/appium/lib/bootstrap/appium-initializer.ts:138-143` |

`fillUndefinedDeep` reads `dest[key]`. For the key `__proto__` that read returns `Object.prototype`, which is not `undefined`, and `isPlainObject(Object.prototype)` is true, so the merge writes the attacker's fields onto `Object.prototype`. `setPath` already refuses `__proto__`. This function does not. Startup merges CLI args, the config file's `server` object, and schema defaults through `defaultsDeep`.

**Input:** `defaultsDeep({}, JSON.parse('{"__proto__":{"relaxedSecurityEnabled":true}}'))`.  
**Expected:** a normal object, `({}).relaxedSecurityEnabled` stays `undefined`.  
**Actual:** `({}).relaxedSecurityEnabled === true` until `Object.prototype.relaxedSecurityEnabled` is deleted.

**Fix direction:** skip `__proto__`, `constructor`, and `prototype` in `fillUndefinedDeep`, the same way `isSafePathKey` does for `setPath`. Copy with `Object.create(null)` or `Object.hasOwn`.

### 11. `reqBasePath: "/"` doubles the proxied session path

| | |
| --- | --- |
| Severity | **High** |
| Package | `@appium/base-driver` |
| Location | `packages/base-driver/lib/wd-proxy/proxy.ts:397-400` and `:129` |

`"/"` is a prefix of every pathname. `pathname.replace("/", "")` removes only the first slash, so `/session/abc/url` becomes `session/abc/url`. The session matcher then fails and `getUrlForProxy` prepends another session. A `base` of `"/"` also inserts `//`.

**Input:** `new WebDriverProxy({server:'127.0.0.1', port:9, reqBasePath:'/', base:'/', sessionId:'proxy-session'}).getUrlForProxy('/session/abc/url', 'GET')`.  
**Expected:** `http://127.0.0.1:9/session/abc/url` (or the proxy session id substituted once).  
**Actual:** `http://127.0.0.1:9//session/proxy-session/session/abc/url`.

**Fix direction:** treat `reqBasePath` of `"/"` as empty, and strip a trailing slash from `base` before joining.

### 12. Integer CLI values keep a numeric prefix

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `appium` |
| Location | `packages/appium/lib/schema/cli-args.ts:132-138` |

`parseInt` / `parseFloat` stop at the first non-digit, then the schema sees only that number. `--port 4723abc` is stored as `4723`. `--port 10e2` is `10`, not `1000`. `--request-timeout 0abc` is `0`, which disables the request timeout.

**Expected:** reject the token.  
**Actual:** `parseArgs(['--port','4723abc']).port === 4723`.

**Fix direction:** accept the token only when the entire string is a canonical integer or number, then run the schema check.

### 13. Inline `--log-filters` JSON is split on commas before `JSON.parse`

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `appium` |
| Location | `packages/appium/lib/schema/cli-args.ts:154-158` |

`log-filters` is an array whose transformer is `json`. Array arguments are CSV-split first, then each piece is parsed as JSON. A filter document contains commas, so the inline form never parses. A file path still works when the path itself has no comma.

**Input:** `--log-filters '[{"text":"password","replacer":"***"}]'`.  
**Expected:** one rule.  
**Actual:** argparse error `invalid argTypeFunction value` after `parseCsvLine` yields `[{"text":"password"` and `"replacer":"***"}]`.

**Fix direction:** when the transformer is `json`, parse the whole argv string (or a file) as one JSON value. Do not CSV-split it first.

### 14. A feature name that matches a file replaces the insecure-feature list

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `appium` |
| Location | `packages/appium/lib/schema/cli-transformers.ts:27-37` |

`allow-insecure` and `deny-insecure` read a regular file before treating the token as a feature name. Directories are ignored. A file in the working directory is not.

**Input:** a file named `adb_shell` whose contents are `*:adb_shell`, then `--allow-insecure adb_shell`.  
**Expected:** the feature `adb_shell`.  
**Actual:** the allow-list is `["*:adb_shell"]`.

**Fix direction:** read a file only when the value looks like a path (`./`, `/`, or a trailing separator), or require an explicit flag. Do not let a cwd file shadow a feature name.

### 15. Log-filter flag `y` is merged with the forced `g` and the secret stays in the line

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/logger` |
| Location | `packages/logger/lib/secure-values-preprocessor.ts:32` and `:54-61` |

`g` is always inserted. A user flag `y` is added as well, producing `gy`. A sticky global replace only matches at index 0, so a secret later in the line is left as-is.

**Input:** `{text:'s3cr3t', flags:'y'}` against `prefix s3cr3t suffix`.  
**Expected:** the secret is masked.  
**Actual:** flags are `gy` and the output is unchanged.

**Fix direction:** do not combine `y` with the forced `g`. Ignore `y`, or apply `y` only when the caller did not also need a global replace.

### 16. A global copy filter drops every other matching path

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/support` |
| Location | `packages/support/lib/fs.ts:118` |

`toCpOptions` uses `filter.test(source)` when the filter is a `RegExp`. A `/g` or `/y` pattern advances `lastIndex`, so the next path is tested from the middle of the previous match.

**Input:** `toCpOptions({filter: /keep/g}).filter` on `/tmp/keep-a`, `/tmp/keep-b`, `/tmp/keep-c`.  
**Expected:** `true, true, true`.  
**Actual:** `true, false, true`. `fs.copyFile` then omits every other matching file.

**Fix direction:** clone the regexp or set `lastIndex = 0` before each `test`.

### 17. `fs.mkdir` reports success when the path is already a file

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `@appium/support` |
| Location | `packages/support/lib/fs.ts:188-195` |

Any `EEXIST` is swallowed, including when a file occupies the path.

**Input:** write `occupied`, then `fs.mkdir(occupied)`.  
**Expected:** throw `EEXIST`.  
**Actual:** the promise resolves and the path is still a file.

**Fix direction:** on `EEXIST`, stat the path and rethrow unless it is a directory.

### 18. Legacy `--webhook` host:port parsing breaks IPv6

| | |
| --- | --- |
| Severity | **Medium** |
| Package | `appium` |
| Location | `packages/appium/lib/logsink.ts:184-187` |

`http://[::1]:9003/logs` is handled by `URL.parse` above this branch. A bare `host:port` value is split on the first colon.

**Input:** `parseWebhookUri('::1')` and `parseWebhookUri('[::1]:9003')`.  
**Expected:** host `::1`, port `9003`.  
**Actual:** `::1` becomes `{host:'127.0.0.1', port:9003}`. `[::1]:9003` becomes `{host:'[', port:9003}`.

**Fix direction:** parse bracketed IPv6 before splitting, and do not fall back to `127.0.0.1` when the host token is empty.

### 19. `escapeSpecialChars` compiles the extra escape character as a regexp

| | |
| --- | --- |
| Severity | **Low** |
| Package | `@appium/support` |
| Location | `packages/support/lib/util.ts:201-202` |

`new RegExp(quoteEscape, 'g')` and a `String.replace` replacement of `` `\\${quoteEscape}` `` both treat the argument as syntax.

**Input:** `escapeSpecialChars('ab', '.')`.  
**Expected:** `ab` with each character unchanged, or `\.` only if `.` itself is being escaped as a literal.  
**Actual:** `'\\.\\.'` because `.` matches every character. `escapeSpecialChars('a', '(')` throws `Invalid regular expression`.

**Fix direction:** escape with `split`/`join` or `replaceAll` on the literal character. Do not build a `RegExp`.

Other leads from that pass were not re-run here, so they are not listed as confirmed: OpenCV `TM_SQDIFF` score polarity, template-match neighbor filtering, a screenshot slice resized to height 0, `initOpenCv` calling `removeAllListeners('unhandledRejection')`, Strongbox empty slugs, `fs.mv` dropping FIFOs, extension `package.json` fields overwriting install bookkeeping, `driver update` exiting 0, and in-process `Manifest.write` coalescing.

## Already fixed on this commit (dropped)

These were real on the fork at `33459705e` and are fixed on `a8d646b6c`. They are not open bugs.

| Fork-era suspect | Where it stands on `a8d646b6c` |
| --- | --- |
| Default capabilities written only onto `firstMatch[0]`, and skipped entirely if any candidate already set the key | `parseCapsForInnerDriver` copies each default onto every `firstMatch` object that does not already have it (`packages/appium/lib/helpers/capability.ts:53-75`) |
| `--allow-insecure` / JSON CLI values treated a directory as a file via `existsSync` | `isRegularFile` uses `statSync().isFile()` and ignores directories (`packages/appium/lib/schema/cli-transformers.ts:85-97`) |
| BiDi `webSocketUrl` left IPv6 addresses unbracketed | `net.formatHostnameForUrl(host)` wraps the host before the URL is built (`packages/appium/lib/appium.ts:397-399`) |
| Timeout debug lines contained an extra `}` | The templates at `timeout.ts:47` and `:62` interpolate one JSON object |
| `compareVersions` used `semver.satisfies` without prerelease inclusion | `packages/support/lib/util.ts` passes `{includePrerelease: true}` |
| `getTimeouts` omitted `script` and `pageLoad` | `getTimeouts` returns `script`, `pageLoad`, `implicit`, and `command` (`timeout.ts:90-96`). W3C values use `validateTimeoutValue` |
| `--address -42` accepted (skipped unit test, old `#18716` note) | Re-checked with `getParser(true)`. `-42` and `not a host` are rejected (`format "hostname"` / `format "ipv6"`). `127.0.0.1` and `localhost` are accepted. `#18716` is closed and was about TypeScript codegen, not this check. The skipped test `should throw an error for an invalid value ("hostname")` is stale: unskipping it should pass |

---

## Test-suite health

Run on `a8d646b6c` after `npm ci` and `npx tsc -b` (Node v22.23.4, npm 10.9.9).

| Check | Result |
| --- | --- |
| `npm ci` | Succeeded |
| `npx tsc -b` | Exit 0 |
| `npm run lint` (`oxlint`) | Exit 0. Warnings only, no errors: `packages/execute-driver-plugin/lib/vm-host-binding.ts` (`prefer-await-to-then` / `prefer-await-to-callbacks` around lines 172-173) and two callback-style warnings in `qa-repro/reproduce-bugs.mjs` |
| `npm run test:unit` (`lerna run test`, 19 packages) | Exit 0. Aggregated node:test counts: **2193 pass, 0 fail, 2 skipped** |

Skipped tests:

1. `packages/appium` parser: `should throw an error for an invalid value ("hostname")` (`it.skip`, comment points at `#18716`). The behavior under test already rejects `-42`. The skip is leftover.
2. `explains when npm.cmd cannot be found and preserves the cause` (Windows `npm.cmd`; skipped on this Linux host).

E2E (`npm run test:e2e`) was not run. Those suites start servers and drivers and were outside the time spent proving the unit-level defects above. Unit tests do not cover the seven cases; that is why they stay green while `qa-repro/reproduce-bugs.mjs` fails them.

---

## Quality and architecture risks

- **Idempotency cache is global.** One LRU serves every connection. A client that reuses a key, or two clients that pick the same key, share a session-creation response for 30 minutes (`packages/base-driver/lib/protocol/idempotency.ts:27-31`).
- **Manifest writes are coalesced only inside one process.** `Manifest.write` shares an in-flight promise (`packages/appium/lib/extension/manifest/manifest.ts:177-207`) and then writes the YAML file directly. Two `appium driver` processes can still interleave `extensions.yaml`.
- **Log masking is a string replace over operator regexes.** Flags are collected with `String.prototype.includes` (`secure-values-preprocessor.ts:56-60`), so a flags word such as `"signature"` turns on `s`, `g`, and `i`. Patterns are compiled as provided, so a hostile filter is a ReDoS vector against the logging path. The `$` bug above is the concrete case that was reproduced.
- **Stale skip hides the address-format regression test.** The hostname check works today and is not asserted.
- **`vm.runInNewContext({timeout})` does not bound an async script.** `packages/execute-driver-plugin/lib/execute-child.ts` passes `timeoutMs` into the VM, which only interrupts synchronous code. The parent in `plugin.ts` races its own timer and kills the child, so a user-facing timeout still fires. The VM option is not the control that enforces it. Not filed as a bug because the parent timer was not shown to fail.
- **Pre-existing lint warnings** in the execute-driver VM bridge (`vm-host-binding.ts:172-173`) ship on master with `npm run lint` still exiting 0.
