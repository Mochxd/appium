// Independent repros for the 19 claims in appium-upstream-qa-audit.md.
// Run from the repo root after `npm ci && npx tsc -b`:  node qa-verify/repro.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, writeFileSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = (p) => import(path.join(root, 'packages', p));

const {ProxyRequest} = await pkg('base-driver/build/lib/wd-proxy/proxy-request.js');
const {WebDriverProxy, BaseDriver} = await pkg('base-driver/build/lib/index.js');
const {handleIdempotency} = await pkg('base-driver/build/lib/protocol/idempotency.js');
const {parseCaps} = await pkg('base-driver/build/lib/basedriver/capabilities.js');
const {SecureValuesPreprocessor} = await pkg('logger/build/lib/secure-values-preprocessor.js');
const {onBidiMessage} = await pkg('appium/build/lib/bidi/commands.js');
const {defaultsDeep} = await pkg('appium/build/lib/utils/object.js');
const {getParser} = await pkg('appium/build/lib/cli/parser.js');
const {transformers} = await pkg('appium/build/lib/schema/cli-transformers.js');
const {parseWebhookUri} = await pkg('appium/build/lib/logsink.js');
const {readConfigFile} = await pkg('appium/build/lib/bootstrap/config-file.js');
const {toCpOptions, fs: afs} = await pkg('support/build/lib/fs.js');
const {escapeSpecialChars} = await pkg('support/build/lib/util.js');

const results = [];
async function check(id, title, fn) {
  try {
    const out = await fn();
    results.push({id, title, out});
    console.log(`#${id} ${title}\n   ${out}`);
  } catch (e) {
    results.push({id, title, out: `ERROR ${e.stack}`});
    console.log(`#${id} ${title}\n   ERROR ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (p) => Promise.race([p.then(() => 'fulfilled', (e) => `rejected: ${e.message}`), sleep(500).then(() => 'pending')]);

/** HTTP server; handler(req, body, res). Never-responding when handler returns without ending. */
async function server(handler) {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {port: s.address().port, close: () => (s.closeAllConnections(), s.close())};
}
const quietLog = {debug() {}, info() {}, warn() {}, error() {}};

// ---------- 1 ----------
await check(1, 'ProxyRequest.cancel() leaves execute() pending; driver-level effect', async () => {
  const srv = await server(() => {}); // never answers
  const req = new ProxyRequest({url: `http://127.0.0.1:${srv.port}/x`, method: 'GET'});
  const p = req.execute();
  await sleep(100);
  req.cancel();
  const raw = await state(p);

  class D extends BaseDriver {
    async hang() {
      return await this.wdProxy.command('/status', 'GET');
    }
    async deleteSession() {
      this.wdProxy.cancelActiveRequests();
      this.sessionId = null;
    }
  }
  const d = new D();
  d.sessionId = 'abc';
  d.newCommandTimeoutMs = 0;
  d.wdProxy = new WebDriverProxy({server: '127.0.0.1', port: srv.port, log: quietLog});
  const cmd = d.executeCommand('hang');
  await sleep(100);
  const activeBefore = d.wdProxy.getActiveRequestsCount();
  await d.startUnexpectedShutdown();
  const driverLevel = await state(cmd);
  srv.close();
  return `raw ProxyRequest.execute() after cancel: ${raw}; executeCommand('hang') after startUnexpectedShutdown (cancels proxy): ${driverLevel}; active before=${activeBefore}`;
});

// ---------- 2 ----------
await check(2, 'Idempotency key reuse: different path runs, different body replays', async () => {
  const express = (await import(path.join(root, 'node_modules/express/index.js'))).default;
  const app = express();
  let calls = 0;
  app.use(handleIdempotency);
  app.use(express.json());
  app.post('/session', (req, res) => res.json({value: {n: ++calls, got: req.body.capabilities.alwaysMatch.browserName}}));
  app.post('/other', (req, res) => res.json({value: {n: ++calls, other: true}}));
  const s = await new Promise((r) => {
    const x = app.listen(0, '127.0.0.1', () => r(x));
  });
  const url = `http://127.0.0.1:${s.address().port}`;
  const post = async (p, browserName) =>
    (await fetch(url + p, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-idempotency-key': 'same-key'},
      body: JSON.stringify({capabilities: {alwaysMatch: {browserName}}}),
    }).then((r) => r.json())).value;
  const a = await post('/session', 'a');
  const b = await post('/other', 'a');
  const c = await post('/session', 'different');
  s.closeAllConnections();
  s.close();
  return `1st=${JSON.stringify(a)} /other=${JSON.stringify(b)} 3rd(body browserName=different)=${JSON.stringify(c)} handlerCalls=${calls}`;
});

// ---------- 3 ----------
await check(3, 'Log filter replacer with $& / $1', async () => {
  const p = new SecureValuesPreprocessor();
  await p.loadRules([{text: 's3cret-token', replacer: '[$&]'}]);
  const a = p.preprocess('Authorization: Bearer s3cret-token');
  await p.loadRules([{pattern: '(.{1,15}).*', flags: 's', replacer: '$1'}]); // example from docs/en/guides/log-filters.md
  const b = p.preprocess('0123456789abcdefghijXYZ');
  return `'[$&]' -> ${JSON.stringify(a)}; documented '$1' truncation example -> ${JSON.stringify(b)}`;
});

// ---------- 4 ----------
await check(4, 'New-session proxy: sessionId captured for /session?q and /session/', async () => {
  const srv = await server((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({value: {sessionId: 'down-1', capabilities: {}}, seenUrl: req.url}));
  });
  const out = [];
  for (const u of ['/session', '/session?trace=1', '/session/']) {
    const px = new WebDriverProxy({server: '127.0.0.1', port: srv.port, log: quietLog});
    const [, body] = await px.proxy(u, 'POST', {capabilities: {}});
    out.push(`${u} -> downstream ${body.seenUrl}, sessionId=${px.sessionId}`);
  }
  srv.close();
  return out.join(' | ');
});

// ---------- 5 ----------
await check(5, 'Legacy {type:"command"} timeouts body reshaped for downstream', async () => {
  let seen;
  const srv = await server((req, body, res) => {
    seen = body;
    res.setHeader('content-type', 'application/json');
    res.end('{"value":null}');
  });
  const px = new WebDriverProxy({server: '127.0.0.1', port: srv.port, sessionId: 'down', log: quietLog});
  await px.proxyCommand('/session/up/timeouts', 'POST', {type: 'command', ms: 60000});
  const cmdBody = seen;
  await px.proxyCommand('/session/up/timeouts', 'POST', {type: 'page load', ms: 100});
  srv.close();
  return `downstream body for command: ${cmdBody}; for 'page load': ${seen}`;
});

// ---------- 6 ----------
await check(6, 'parseTimeoutArgument / command timeout accepts junk', async () => {
  const d = new BaseDriver();
  d.log.debug = d.log.warn = () => {};
  const vals = ['10abc', '0x10', 10.9, '1e3'].map((v) => `${JSON.stringify(v)}->${d.parseTimeoutArgument(v)}`);
  await d.timeouts(undefined, undefined, undefined, undefined, undefined, '10abc');
  let implicitErr;
  try {
    await d.timeouts(undefined, undefined, undefined, undefined, '10abc');
  } catch (e) {
    implicitErr = e.constructor.name;
  }
  return `${vals.join(', ')}; W3C command:'10abc' -> newCommandTimeoutMs=${d.newCommandTimeoutMs}; W3C implicit:'10abc' -> ${implicitErr}`;
});

// ---------- 7 ----------
await check(7, 'BiDi missing params message quote', async () => {
  const drv = {log: quietLog};
  const res = await onBidiMessage.call({}, Buffer.from('{"id":7,"method":"session.status"}'), drv, []);
  const res2 = await onBidiMessage.call({}, Buffer.from('{"id":8,"params":{}}'), drv, []);
  return `params: ${JSON.stringify(res.message)} | method: ${JSON.stringify(res2.message)}`;
});

// ---------- 8 ----------
await check(8, 'firstMatch duplicate of alwaysMatch key fails the whole request', async () => {
  try {
    const r = parseCaps(
      {alwaysMatch: {platformName: 'Android'}, firstMatch: [{platformName: 'Android', 'appium:deviceName': 'bad'}, {'appium:deviceName': 'emu'}]},
      {},
    );
    return `matched ${JSON.stringify(r.matchedCaps)}`;
  } catch (e) {
    return `${e.constructor.name}: ${e.message.slice(0, 90)}`;
  }
});

// ---------- 9 ----------
await check(9, 'implicit: null -> unbounded wait', async () => {
  const d = new BaseDriver();
  d.log.debug = d.log.warn = () => {};
  await d.timeouts(undefined, undefined, undefined, undefined, null);
  let n = 0;
  const p = d.implicitWaitForCondition(async () => ++n >= 3);
  const r = await p;
  return `accepted; implicitWaitMs=${d.implicitWaitMs}; condition polled until true (n=${n}, result=${r}) i.e. no deadline`;
});

const p = await getParser(true); // also finalizes the config schema used by readConfigFile

// ---------- 10 ----------
await check(10, 'defaultsDeep with own __proto__ key', async () => {
  const merged = defaultsDeep({}, JSON.parse('{"__proto__":{"relaxedSecurityEnabled":true}}'));
  const polluted = ({}).relaxedSecurityEnabled;
  delete Object.prototype.relaxedSecurityEnabled;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa10-'));
  const cfg = path.join(dir, '.appiumrc.json');
  writeFileSync(cfg, '{"server":{"__proto__":{"relaxedSecurityEnabled":true}}}');
  const r = await readConfigFile(cfg);
  // Same merge order as AppiumInitializer.finishServerInit
  const cfg2 = path.join(dir, 'nested.appiumrc.json');
  writeFileSync(cfg2, '{"server":{"default-capabilities":{"__proto__":{"polluted":true}}}}');
  const r2 = await readConfigFile(cfg2);
  const {getDefaultsForSchema} = await pkg('appium/build/lib/schema/schema.js');
  defaultsDeep({}, p.parseArgs(['--default-capabilities', '{"appium:a":1}']), r2.config.server, getDefaultsForSchema(false));
  const nested = ({}).polluted;
  delete Object.prototype.polluted;
  return `defaultsDeep -> ({}).relaxedSecurityEnabled=${polluted} (merged own keys: ${JSON.stringify(Object.keys(merged))}); readConfigFile(server.__proto__) errors: ${JSON.stringify(r.errors?.map((e) => e.message ?? e))}; config default-capabilities.__proto__ (accepted, errors=${JSON.stringify(r2.errors)}) + CLI --default-capabilities -> ({}).polluted=${nested}`;
});

// ---------- 11 ----------
await check(11, 'reqBasePath "/" doubles session path', async () => {
  const px = new WebDriverProxy({server: '127.0.0.1', port: 9, reqBasePath: '/', base: '/', sessionId: 'proxy-session', log: quietLog});
  const px2 = new WebDriverProxy({server: '127.0.0.1', port: 9, reqBasePath: '/', sessionId: 'proxy-session', log: quietLog});
  return `base '/': ${px.getUrlForProxy('/session/abc/url', 'GET')} | base default: ${px2.getUrlForProxy('/session/abc/url', 'GET')}`;
});

const tryParse = (argv) => {
  try {
    return JSON.stringify(p.parseArgs([...argv])[argv[0].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())]);
  } catch (e) {
    return `ERROR ${e.message.split('\n')[0].slice(0, 120)}`;
  }
};

// ---------- 12 ----------
await check(12, 'Integer/number CLI values keep a numeric prefix', async () =>
  ['4723abc', '10e2', '47.9'].map((v) => `--port ${v} -> ${tryParse(['--port', v])}`).join(', ') +
  `, --keep-alive-timeout 0abc -> ${tryParse(['--keep-alive-timeout', '0abc'])}`);

// ---------- 13 ----------
await check(13, 'Inline --log-filters JSON', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa13-'));
  const f = path.join(dir, 'filters.json');
  writeFileSync(f, '[{"text":"password","replacer":"***"}]');
  return `inline -> ${tryParse(['--log-filters', '[{"text":"password","replacer":"***"}]'])} | single-key inline -> ${tryParse(['--log-filters', '[{"text":"password"}]'])} | file -> ${tryParse(['--log-filters', f])}`;
});

// ---------- 14 ----------
await check(14, 'cwd file named like a feature replaces --allow-insecure value', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa14-'));
  const cwd = process.cwd();
  process.chdir(dir);
  writeFileSync('adb_shell', '*:adb_shell\n');
  try {
    return `transformer -> ${JSON.stringify(transformers.csv('adb_shell'))}; parser --allow-insecure adb_shell -> ${tryParse(['--allow-insecure', 'adb_shell'])}`;
  } finally {
    process.chdir(cwd);
  }
});

// ---------- 15 ----------
await check(15, 'flags "y" combined with forced "g"', async () => {
  const pp = new SecureValuesPreprocessor();
  await pp.loadRules([{text: 's3cr3t', flags: 'y'}]);
  return `flags=${pp.rules[0].pattern.flags}; 'prefix s3cr3t suffix' -> ${JSON.stringify(pp.preprocess('prefix s3cr3t suffix'))}; 's3cr3t at start' -> ${JSON.stringify(pp.preprocess('s3cr3t at start'))}`;
});

// ---------- 16 ----------
await check(16, 'toCpOptions with /g RegExp filter', async () => {
  const f = toCpOptions({filter: /keep/g}).filter;
  const viaTest = ['/tmp/keep-a', '/tmp/keep-b', '/tmp/keep-c'].map((s) => f(s, '/dst'));
  const src = mkdtempSync(path.join(os.tmpdir(), 'qa16src-'));
  const dst = path.join(os.tmpdir(), `qa16dst-${process.pid}`);
  for (const n of ['keep-a', 'keep-b', 'keep-c']) {
    writeFileSync(path.join(src, n), n);
  }
  let copyResult;
  try {
    await afs.copyFile(path.join(src, 'keep-a'), path.join(dst, 'keep-a'), {filter: /keep/g});
    copyResult = 'single file copy ok';
  } catch (e) {
    copyResult = e.message;
  }
  return `filter results: ${JSON.stringify(viaTest)}; ${copyResult}`;
});

// ---------- 17 ----------
await check(17, 'fs.mkdir on an existing regular file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa17-'));
  const f = path.join(dir, 'occupied');
  writeFileSync(f, 'x');
  const r1 = await afs.mkdir(f).then(() => 'resolved', (e) => `rejected ${e.code}`);
  const r2 = await afs.mkdir(f, {recursive: true}).then(() => 'resolved', (e) => `rejected ${e.code}`);
  return `mkdir(file) -> ${r1}, isFile=${statSync(f).isFile()}; mkdir(file,{recursive:true}) -> ${r2}`;
});

// ---------- 18 ----------
await check(18, 'Legacy --webhook host:port with IPv6', async () =>
  `parseWebhookUri('::1')=${JSON.stringify(parseWebhookUri('::1'))}; parseWebhookUri('[::1]:9003')=${JSON.stringify(parseWebhookUri('[::1]:9003'))}; ` +
  `CLI --webhook '[::1]:9003' -> ${tryParse(['--webhook', '[::1]:9003'])}; CLI --webhook '::1' -> ${tryParse(['--webhook', '::1'])}; CLI --webhook localhost:9003 -> ${tryParse(['--webhook', 'localhost:9003'])}`);

// ---------- 19 ----------
await check(19, 'escapeSpecialChars quoteEscape treated as regexp', async () => {
  let paren;
  try {
    paren = JSON.stringify(escapeSpecialChars('a(', '('));
  } catch (e) {
    paren = `throws ${e.constructor.name}: ${e.message}`;
  }
  return `('ab','.') -> ${JSON.stringify(escapeSpecialChars('ab', '.'))}; ("it's","'") -> ${JSON.stringify(escapeSpecialChars("it's", "'"))}; ('a(','(') -> ${paren}`;
});

assert.equal(results.length, 19);
process.exit(0);
