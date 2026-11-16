# Independent verification of `appium-upstream-qa-audit.md`

- **Commit:** `a8d646b6ccbe61335618bfdc039fd2050b7c9194` (`fix(support): apply case-only moves on macOS too (#23147)`), which is also the current `appium/appium` `master` (`git ls-remote` on 2026-11-16).
- **Method:** I wrote new repros from the claims and the source only, without looking at the first agent's scripts or branch. Everything runs against the compiled packages after `npm ci && npx tsc -b` (both exit 0, Node v22.23.4).
  - `node qa-verify/repro.mjs` checks all 19 claims at unit level. Its output is saved in `qa-verify/repro-output.txt`.
  - `bash qa-verify/e2e.sh` checks claims 12, 13 and 18 against the real `appium` server entry point. Its output is saved in `qa-verify/e2e-output.txt`.
- **ChaosEngine:**
  - The exact one-liner from the task (`curl … bootstrap.py | python3 - --hosts cursor --consumer`) exits 2 with `the following arguments are required: --repository`.
  - Adding `--repository ShaftHQ/chaosengine-harness --branch main --yes`, still piped, fails at "Download source" with `No module named 'bootstrap'`. The script imports itself by file name.
  - Saving the script as `bootstrap.py` and running it from a file worked. All 6 install phases passed, and `install.py status` reports `healthy` (14/15 components, graphify degraded).
  - `tool.py retrieve --store graphify` returned `skipped` (`no-rare-token`, stale graph, 0 hits), so it saved nothing and I read source files directly.
  - The installer modified `.gitignore` and `AGENTS.md` and added overlay files. None of these were committed.

## Summary

Of the 19 claims, 11 are real defects, but all of them are Low severity. The other 8 are intended or documented behaviour, or cannot be reached through supported input. None of the 5 claimed High-severity bugs holds up at High.

| # | Title | Orig. sev. | Verdict | My sev. | One-line evidence |
|---|---|---|---|---|---|
| 1 | Cancelling a proxied request hangs the caller | High | NOT A BUG / INTENDED | Low (leak only) | Raw `execute()` stays pending by design (#22293: `// do not propagate the error to callers`). `executeCommand` still rejects with "The driver was unexpectedly shut down!" through the shutdown race. |
| 2 | Idempotency key does not pin the request | Medium | CONFIRMED (partly by design) | Low | Same key on `/other` runs the handler (explicit warn-and-`next()`). Same key with a different body replays `{"n":1,"got":"a"}`. |
| 3 | Log-filter replacer reinserts the secret via `$&` | Medium | NOT A BUG | – | `$` patterns are a documented feature: the guide's own example uses `"replacer": "$1"`, and the proposed fix would break it. |
| 4 | New-session proxy drops sessionId for `/session?q` and `/session/` | Medium | CONFIRMED | Low | `/session?trace=1` and `/session/` both give `sessionId=null`. No in-repo path proxies those URL forms. |
| 5 | Legacy `{type:'command'}` timeout forwarded as `{command:…}` | Medium | CONFIRMED | Low | Downstream body is `{"command":60000}`. W3C remotes ignore unknown keys, so the timeout is silently dropped. Deprecated input. |
| 6 | `parseTimeoutArgument` accepts non-integers | Low | CONFIRMED | Low | `"10abc"→10`, `"0x10"→0`, `10.9→10`, `"1e3"→1`. W3C `command:"10abc"` sets 10 ms. |
| 7 | BiDi "missing params" error drops closing quote | Low | CONFIRMED | Low (cosmetic) | `…in '{"id":7,"method":"session.status"}` has no trailing `'`. The "missing method" message has one. |
| 8 | One bad `firstMatch` candidate rejects the whole session | High | NOT A BUG (spec-mandated) | – | The spec says "the result of *trying* to merge capabilities", so errors propagate. Implemented deliberately in #22982 for #22966 item F11. |
| 9 | `implicit: null` makes find wait forever | High | NOT A BUG (spec-mandated) | – | The current spec allows `null` for implicit, and Find Elements says "If timeout is not null: start the timer". Unit test `timeout.spec.ts:240` asserts this. |
| 10 | `defaultsDeep` copies `__proto__` onto `Object.prototype` | High | CONFIRMED | Low (hardening) | Pollution is reachable with config `default-capabilities.__proto__` plus CLI `--default-capabilities`. Top-level `server.__proto__` is rejected by the schema. Only the operator controls these inputs. |
| 11 | `reqBasePath: "/"` doubles the proxied session path | High | CONFIRMED (API level) | Low | `http://127.0.0.1:9//session/proxy-session/session/abc/url`. Appium's `normalizeBasePath('/')` returns `''`, so only a driver that hardcodes `'/'` is affected. |
| 12 | Integer CLI values keep a numeric prefix | Medium | CONFIRMED (E2E) | Low | Real server started with `--port 4723abc` listens on 4723. Also `10e2→10`, `47.9→47`, `--keep-alive-timeout 0abc→0`. |
| 13 | Inline `--log-filters` JSON split on commas | Medium | NOT A BUG (documented limitation) | Low (UX) | Inline JSON fails, but the guide documents only "a path to a valid JSON file" for the CLI. The file form works. |
| 14 | cwd file named like a feature replaces the insecure list | Medium | NOT A BUG (by design) | – | Schema description says "a path to a text file … or a comma-delimited list". The code comment says "attempt file first". Only the operator controls cwd. |
| 15 | Flag `y` merged with forced `g` leaves the secret | Medium | NOT A BUG | – | The guide says `g` is always enabled. A user who asks for sticky gets standard `gy` semantics (start-anchored masking works). |
| 16 | `/g` RegExp copy filter drops every other path | Medium | CONFIRMED | Low | `toCpOptions({filter:/keep/g}).filter` gives `[true,false,true]`. No in-repo caller passes a `/g` regex. |
| 17 | `fs.mkdir` reports success when the path is a file | Medium | CONFIRMED | Low | Resolves (with and without `recursive`) and the path is still a file. This contradicts its docstring. In-repo callers fail later or re-verify. |
| 18 | Legacy `--webhook host:port` breaks IPv6 | Medium | NOT REPRODUCIBLE via supported input | – | `parseWebhookUri('[::1]:9003')` returns `host:'['`, but `--webhook '[::1]:9003'` and `'::1'` are rejected by `format: uri` before that code runs. |
| 19 | `escapeSpecialChars` compiles `quoteEscape` as a regexp | Low | CONFIRMED | Low | `('ab','.')` returns `"\\.\\."`. `('a(','(')` throws `SyntaxError`. No in-repo callers. |

**Duplicates:** none of the 19 claims duplicates an open upstream issue or PR. These are related:

- Bug 8 is the opposite of the deliberate conformance fix #22982 ([#22966](https://github.com/appium/appium/issues/22966) item F11).
- Bug 9 is covered by #22961 (null timeouts kept on purpose, in the same review).
- Bug 10 matches the pattern of the open PR [#23132](https://github.com/appium/appium/pull/23132) (prototype keys in device settings), but that PR touches a different file.
- Bug 13 is related to the closed issue [#19822](https://github.com/appium/appium/issues/19822) (`--log-filters` file form, fixed).
- Bug 18 sits next to the merged PRs [#22635](https://github.com/appium/appium/pull/22635) and [#23061](https://github.com/appium/appium/pull/23061), which fixed URI-form and IPv6 webhooks and deliberately kept the legacy fallback.

---

## Details

### 1. ProxyRequest cancel never settles — NOT A BUG / INTENDED, Low

- **Repro (`#1`):** an HTTP server that never answers. `new ProxyRequest(...).execute()` is started, then `cancel()` is called. After 500 ms the promise is **pending**, so the mechanism is real.
- **Why it is intended:** `proxy-request.ts:46-48` returns a never-settling promise under the comment `// The request was cancelled; do not propagate the error to callers.` It was introduced on purpose in #22293 ("Ditch bluebird"), whose description says `cancel()` "aborts the in-flight axios request without propagating a cancellation error to callers (preserves the intent of `cancelActiveRequests()`)". Before #22293, `cancel()` rejected with bluebird's `CancellationError`, so the observable semantics did change in that PR, but deliberately.
- **No client-facing hang:** I subclassed `BaseDriver` with a command that awaits `wdProxy.command('/status')` and a `deleteSession` that calls `cancelActiveRequests()`. After `startUnexpectedShutdown()`, `executeCommand` **rejects** with `The driver was unexpectedly shut down!`, because `driver.ts:136-147` races every command (including `proxyReqRes`) against the shutdown event. A normal `deleteSession` is queued behind the in-flight command, so it cannot cancel it mid-flight.
- **Residual issue:** each cancelled request leaves one orphaned promise and closure. That is a design smell, not High severity.

### 2. Idempotency key not pinned to the request — CONFIRMED (partly by design), Low

- **Repro (`#2`):** a real Express app with `handleIdempotency`, sending `POST /session` (body A), then `POST /other` (same key), then `POST /session` (body B):

  ```text
  1st={"n":1,"got":"a"} /other={"n":2,"other":true} 3rd(body browserName=different)={"n":1,"got":"a"} handlerCalls=2
  ```

- **Expected (IETF Idempotency-Key draft):** a 422 on payload mismatch.
- **By design:** continuing on a path mismatch is an explicit choice (`idempotency.ts:69-73` warns "Is the client generating idempotency keys properly?" and calls `next()`). The real gap is that a body mismatch is replayed.
- **Severity:** official clients send a fresh UUID per request, so this needs a buggy client. Low. Note there are **no unit tests** for this middleware.

### 3. `$&` in log-filter replacer — NOT A BUG

- `'[$&]'` gives `Authorization: Bearer [s3cret-token]`, as the claim says.
- However, `docs/en/guides/log-filters.md` ("Truncate all log lines…") documents `"replacer": "$1"`, and my repro shows that example working (`0123456789abcde`). Substitution patterns are a supported feature. Passing a function replacer would break documented configs.
- At most, the docs could add a note.

### 4. sessionId not captured for `/session?…` and `/session/` — CONFIRMED, Low

- **Repro (`#4`):** a fake downstream returns `{value:{sessionId:'down-1'}}`:

  ```text
  /session -> sessionId=down-1 | /session?trace=1 -> downstream /session?trace=1, sessionId=null | /session/ -> downstream /session, sessionId=null
  ```

- **Expected:** `down-1` in all three cases.
- **Severity:** Low. New Session is never forwarded from a client via `proxyReqRes`, and drivers call `proxy.command('/session', 'POST', …)` with the literal path.

### 5. Legacy command timeout forwarded downstream — CONFIRMED, Low

- **Repro (`#5`):** `proxyCommand('/session/up/timeouts','POST',{type:'command',ms:60000})` sends `{"command":60000}` downstream. `'page load'` is correctly sent as `{"pageLoad":100}`.
- **Effect:** the spec's timeout deserialization skips unknown keys, so W3C remotes ignore it and Appium does not apply it locally. The timeout is silently lost.
- **Severity:** Low, because `{type, ms}` is deprecated input.

### 6. `parseTimeoutArgument` lax parsing — CONFIRMED, Low (agree)

- **Repro (`#6`):**

  ```text
  "10abc"->10, "0x10"->0, 10.9->10, "1e3"->1; W3C command:'10abc' -> newCommandTimeoutMs=10; W3C implicit:'10abc' -> InvalidArgumentError
  ```

- `"1e3"` becoming 1 is an extra case the audit did not list.

### 7. BiDi missing-params quote — CONFIRMED, Low (agree)

- **Repro (`#7`):** the message is `Missing params for BiDi operation in '{"id":7,"method":"session.status"}`, with no closing quote. The "missing method" counterpart has one. See `commands.ts:150`.

### 8. firstMatch duplicate fails the whole request — NOT A BUG

- **Repro (`#8`):** `InvalidArgumentError: property 'platformName' should not exist on both primary …`, as the claim says.
- **Spec:** W3C *Processing capabilities* says "Let merged be the result of **trying** to merge capabilities…". In spec language, "trying" means any error is returned immediately. The same applies to validation ("trying to validate capabilities").
- **Upstream intent:** conformance review [#22966](https://github.com/appium/appium/issues/22966) item F11 asks to "Validate and merge every `firstMatch` candidate before matching, including later invalid/duplicate candidates", and #22982 implemented it. The code comments at `capabilities.ts:346,404` say the same.

### 9. `implicit: null` waits forever — NOT A BUG

- **Repro (`#9`):** `null` is accepted, and `implicitWaitForCondition` polls until the condition succeeds, with no deadline.
- **Spec:**
  - The current editor's draft defines the implicit wait timeout as "an integer or null".
  - Deserialization accepts null for **all three** keys. The audit's statement that null is allowed "only for script and pageLoad" is wrong.
  - Find Elements says "If timeout is not null: Start the timer". So null means no deadline, which is exactly what `?? Infinity` implements.
- **Upstream intent:** `timeout.spec.ts:240` ("should keep polling without a deadline when the implicit timeout is null") asserts this, and it came from #22961.

### 10. `defaultsDeep` prototype pollution — CONFIRMED, Low (hardening)

- **Repro (`#10`):**
  - `defaultsDeep({}, JSON.parse('{"__proto__":{"relaxedSecurityEnabled":true}}'))` makes `({}).relaxedSecurityEnabled === true`.
  - **Reachability check:** a config file with top-level `server.__proto__` is rejected (`must NOT have additional properties`). But `{"server":{"default-capabilities":{"__proto__":{"polluted":true}}}}` passes validation. Combined with CLI `--default-capabilities '{"appium:a":1}'` and merged in the same order as `AppiumInitializer.finishServerInit`, it gives `({}).polluted === true`. With the config alone there is no pollution, because `copyForDefaultsDeep` only rewires the copy's own prototype.
- **Severity:** both inputs are operator-controlled. An operator can already pass `--relaxed-security`, so no trust boundary is crossed. It is still worth fixing as hardening, in line with the open PR #23132.

### 11. `reqBasePath: '/'` — CONFIRMED (API level), Low

- **Repro (`#11`):**
  - With `base: '/'`: `http://127.0.0.1:9//session/proxy-session/session/abc/url`.
  - With the default `base`: `http://127.0.0.1:9/session/proxy-session/session/abc/url`. The session path is doubled even without the `//`.
- **Severity:** `main-helpers.ts:155` passes `--base-path` through `normalizeBasePath`, which turns `/` into `''`. So the server's own base path never yields `'/'`, and only a driver that hardcodes it is affected.

### 12. Integer/number CLI prefix parsing — CONFIRMED (E2E), Low

- **E2E (`e2e.sh`):** `node packages/appium/index.js --port 4723abc` logs `listener started on http://0.0.0.0:4723`, and `/status` returns ready. Expected: an argparse error.
- **Unit (`#12`):** `10e2→10`, `47.9→47` (the integer type silently truncates), and `--keep-alive-timeout 0abc→0`.
- **Severity:** operator typo tolerance with no security impact. Low.

### 13. Inline `--log-filters` JSON — NOT A BUG (documented limitation), Low UX

- **Repro:** inline JSON with a comma fails with `invalid argTypeFunction value` (unit and E2E). Inline JSON without a comma (`[{"text":"password"}]`) and the file form both parse.
- **Docs:** `docs/en/guides/log-filters.md` says the CLI value must be "a path to a valid JSON file". The inline array is documented only for config files.
- **Improvement worth making:** the error message is opaque, and the `json` transformer docstring suggests that inline JSON should work.

### 14. Feature name shadowed by a cwd file — NOT A BUG (by design)

- **Repro (`#14`):** with a file `adb_shell` containing `*:adb_shell` in cwd, `--allow-insecure adb_shell` gives `["*:adb_shell"]`.
- **By design:** the schema description says "If string, a path to a text file containing policy or a comma-delimited list", and `cli-transformers.ts:30` says "attempt file first". The cwd is the operator's own.

### 15. `y` combined with `g` — NOT A BUG

- **Repro (`#15`):** the flags become `gy`. `prefix s3cr3t suffix` is unchanged, while `s3cr3t at start` becomes `**SECURE** at start`.
- **Why:** this is standard JavaScript semantics for a sticky global regex, which the user explicitly requested. The guide states that `g` is always enabled.

### 16. Stateful `/g` RegExp copy filter — CONFIRMED, Low

- **Repro (`#16`):** `toCpOptions({filter: /keep/g}).filter` on `keep-a`, `keep-b`, `keep-c` returns `[true,false,true]`. Expected: all `true`.
- **Severity:** a public `@appium/support` API, but no in-repo caller passes a regex filter. `ncp` had the same `filter.test` behaviour. Low.

### 17. `fs.mkdir` on an existing file — CONFIRMED, Low

- **Repro (`#17`):** `mkdir(file)` resolves and `mkdir(file, {recursive:true})` resolves, with `isFile=true`. Expected: `EEXIST`.
- **Why it is a bug:** the docstring says it "will not reject if the **directory** already exists".
- **Severity:** callers either use `recursive` and then fail on the next write with `ENOTDIR`, or re-verify (`zip-entry-writer.ts:424-426`). Low.

### 18. Legacy webhook IPv6 — NOT REPRODUCIBLE via supported input

- **Function level:** `parseWebhookUri('::1')` returns `{host:'127.0.0.1',port:9003}`, and `'[::1]:9003'` returns `{host:'[',port:9003}`.
- **E2E:** `--webhook '[::1]:9003'` and `--webhook '::1'` are both rejected by the schema's `format: "uri"` before `parseWebhookUri` runs. `localhost:9003` passes only because it parses as a URI with scheme `localhost`.
- **Context:** IPv6 is supported through the URL form (`http://[::1]:9003/logs`, fixed in #23061).
- **Side finding:** the argparse error for `--webhook` is empty (`argument --webhook/-G: ` with no reason).

### 19. `escapeSpecialChars` regexp injection — CONFIRMED, Low (agree)

- **Repro (`#19`):** `('ab','.')` returns `"\\.\\."`, and `('a(','(')` throws `SyntaxError: Invalid regular expression: /(/g: Unterminated group`.
- **Context:** public util with no in-repo callers.

---

## Worth filing upstream

1. **#12**: CLI integer and number arguments accept trailing junk and truncate floats (`--port 4723abc` gives 4723). Real E2E repro, trivial fix.
2. **#10**: `defaultsDeep` should skip `__proto__`, `constructor` and `prototype`. Hardening, in line with the open PR #23132.
3. **#2**: the idempotency middleware replays a cached response for a different body under the same key. It has no unit tests, and should probably return 422 on a body mismatch.
4. **#4 + #11** (one `WebDriverProxy` issue): new-session detection uses raw `endsWith('/session')`, and a `reqBasePath` of `'/'` doubles the session path.
5. **Small batch for `@appium/support`, #16 / #17 / #19**: the stateful `/g` filter, `mkdir` swallowing `EEXIST` for files, and `escapeSpecialChars` regexp injection.
6. **Trivial nits, #6 / #7**: strict `parseTimeoutArgument`, and the missing quote in the BiDi error message.

Not worth filing: #1, #3, #8, #9, #14 and #15 (intended or spec-mandated), #13 (documented; a docs or error-message tweak at most), and #18 (unreachable).
