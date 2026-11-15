/* oxlint-disable no-console -- standalone repro script, not product code */
/**
 * Minimal reproductions for bugs on upstream appium master a8d646b6c.
 * Each case prints PASS (bug reproduced) or FAIL (behavior matched the expected fix).
 * Exit code is the number of cases that did not reproduce.
 */
import http from 'node:http';
import {EventEmitter, once} from 'node:events';

import {BaseDriver, handleIdempotency, WebDriverProxy} from '../packages/base-driver/build/lib/index.js';
import {ProxyRequest} from '../packages/base-driver/build/lib/wd-proxy/proxy-request.js';
import {SecureValuesPreprocessor} from '../packages/logger/build/lib/secure-values-preprocessor.js';
import {onBidiMessage} from '../packages/appium/build/lib/bidi/commands.js';

const results = [];

function record(name, reproduced, detail) {
  results.push({name, reproduced, detail});
  console.log(`${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${name}`);
  console.log(`  ${detail}`);
}

async function reproProxyCancelHangs() {
  const server = http.createServer(() => {
    // never respond; cancel must abort the waiter
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  const req = new ProxyRequest({
    url: `http://127.0.0.1:${port}/slow`,
    method: 'GET',
    timeout: 30000,
  });
  const pending = req.execute();
  await new Promise((resolve) => setTimeout(resolve, 50));
  req.cancel();
  const winner = await Promise.race([
    pending.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
  ]);
  server.close();
  record(
    'ProxyRequest.cancel() never settles the in-flight request',
    winner === 'hung',
    `after cancel(), execute() ${winner} (expected a rejection so callers can finish; a hang deadlocks session teardown)`,
  );
}

async function reproLogReplacerLeak() {
  const preprocessor = new SecureValuesPreprocessor();
  await preprocessor.loadRules([{text: 's3cret-token', replacer: '[$&]'}]);
  const out = preprocessor.preprocess('Authorization: Bearer s3cret-token');
  const leaked = out.includes('s3cret-token');
  record(
    'Log filter replacer treats $& as the matched secret',
    leaked,
    `output=${JSON.stringify(out)} (a replacement string of "[$&]" should mask the secret, not splice it back in)`,
  );
}

async function reproSessionIdQuery() {
  const proxy = new WebDriverProxy({server: '127.0.0.1', port: 9});
  proxy.request = async () => ({
    status: 200,
    headers: {},
    data: {value: {sessionId: 'abc', capabilities: {}}},
  });
  await proxy.proxy('/session?trace=1', 'POST', {});
  const queryMissed = proxy.sessionId == null;
  proxy.sessionId = null;
  await proxy.proxy('/session/', 'POST', {});
  const slashMissed = proxy.sessionId == null;
  record(
    'New-session proxy ignores query string and trailing slash when storing sessionId',
    queryMissed && slashMissed,
    `query sessionId=${queryMissed ? 'unset' : proxy.sessionId}, trailing-slash sessionId unset=${slashMissed}`,
  );
}

async function reproIdempotencyMismatchExecutes() {
  const calls = [];
  const next = () => {
    calls.push('next');
  };
  const socket = {
    writable: true,
    write(chunk, enc, cb) {
      if (typeof enc === 'function') {
        enc();
      } else if (typeof cb === 'function') {
        cb();
      }
      return true;
    },
  };
  const res = new EventEmitter();
  Object.assign(res, {
    socket,
    destroyed: false,
    getHeaders() {
      return {};
    },
    statusCode: 200,
  });
  const req1 = {
    headers: {'x-idempotency-key': 'same-key'},
    method: 'POST',
    path: '/session',
    body: {capabilities: {alwaysMatch: {browserName: 'a'}}},
  };
  const req2 = {headers: {'x-idempotency-key': 'same-key'}, method: 'POST', path: '/other', body: {}};
  await handleIdempotency(req1, res, next);
  res.emit('finish');
  await handleIdempotency(req2, res, next);

  const replayed = [];
  const samePath = new EventEmitter();
  Object.assign(samePath, {
    socket: {
      writable: true,
      write(chunk) {
        replayed.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      },
    },
    destroyed: false,
    getHeaders() {
      return {};
    },
    statusCode: 200,
  });
  const req3 = {
    headers: {'x-idempotency-key': 'same-key'},
    method: 'POST',
    path: '/session',
    body: {capabilities: {alwaysMatch: {browserName: 'different'}}},
  };
  const next3 = () => calls.push('next-different-body');
  await handleIdempotency(req3, samePath, next3);
  record(
    'Reused idempotency key on a different path still runs the handler',
    calls.includes('next') && calls.length === 2 && !calls.includes('next-different-body'),
    `different path called next (${calls.join(',') || 'none'}); same path with a different body replayed without next() (${replayed.length} socket write(s)). Neither case compares the body or returns 422.`,
  );
}

function reproParseTimeout() {
  const driver = new BaseDriver({});
  const trailing = driver.parseTimeoutArgument('10abc');
  const hex = driver.parseTimeoutArgument('0x10');
  const float = driver.parseTimeoutArgument(10.9);
  record(
    'parseTimeoutArgument accepts trailing junk, hex-looking strings, and truncates floats',
    trailing === 10 && hex === 0 && float === 10,
    `parseTimeoutArgument('10abc')=${trailing}, parseTimeoutArgument('0x10')=${hex}, parseTimeoutArgument(10.9)=${float}`,
  );
}

async function reproBidiMissingQuote() {
  const driver = {log: {info() {}, error() {}, warn() {}}};
  const message = await onBidiMessage.call(
    {},
    Buffer.from(JSON.stringify({id: 7, method: 'session.status'})),
    driver,
    [],
  );
  const text = message.message ?? '';
  record(
    'BiDi missing-params error omits the closing quote',
    text.includes("in '") && !text.endsWith("'"),
    `message=${JSON.stringify(text)}`,
  );
}

function reproTimeoutProxyBody() {
  const proxy = new WebDriverProxy({server: '127.0.0.1', port: 9});
  const body = proxy.getTimeoutsRequestBody({type: 'command', ms: 60000});
  record(
    'Proxied legacy command timeout is rewritten to a non-W3C key',
    body && Object.hasOwn(body, 'command') && body.command === 60000,
    `rewritten body=${JSON.stringify(body)} (Appium's command timeout is not a W3C timeout name)`,
  );
}

await reproProxyCancelHangs();
await reproLogReplacerLeak();
await reproSessionIdQuery();
await reproIdempotencyMismatchExecutes();
reproParseTimeout();
await reproBidiMissingQuote();
reproTimeoutProxyBody();

const missed = results.filter((r) => !r.reproduced);
console.log(`\n${results.length - missed.length}/${results.length} bugs reproduced`);
if (missed.length) {
  process.exitCode = missed.length;
}
