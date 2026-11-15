/* oxlint-disable no-console */
/**
 * Follow-up reproductions for claims that arrived after the first audit.
 * Prints REPRODUCED or NOT REPRODUCED. Does not change product code.
 */
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {BaseDriver, WebDriverProxy, processCapabilities} from '../packages/base-driver/build/lib/index.js';
import {SecureValuesPreprocessor} from '../packages/logger/build/lib/secure-values-preprocessor.js';
import {getParser} from '../packages/appium/build/lib/cli/parser.js';
import {parseWebhookUri} from '../packages/appium/build/lib/logsink.js';
import {defaultsDeep} from '../packages/appium/build/lib/utils/object.js';
import {fs, util} from '../packages/support/build/lib/index.js';
import {toCpOptions} from '../packages/support/build/lib/fs.js';

const results = [];
function record(name, reproduced, detail) {
  results.push({name, reproduced});
  console.log(`${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${name}`);
  console.log(`  ${detail}`);
}

async function firstMatchDuplicateKey() {
  let message = '';
  try {
    processCapabilities(
      {
        alwaysMatch: {platformName: 'Android'},
        firstMatch: [{platformName: 'Android', 'appium:deviceName': 'bad'}, {'appium:deviceName': 'emu'}],
      },
      {},
      false,
    );
  } catch (err) {
    message = err.message;
  }
  record(
    'one firstMatch key clash fails the whole request',
    /should not exist on both/.test(message),
    message || 'parse succeeded',
  );
}

async function implicitNull() {
  const driver = new BaseDriver({});
  await driver.timeouts(undefined, undefined, undefined, undefined, null);
  const waitMs = driver.implicitWaitMs ?? Infinity;
  record(
    'implicit null becomes an infinite find wait',
    driver.implicitWaitMs === null && waitMs === Infinity,
    `implicitWaitMs=${driver.implicitWaitMs} waitMs=${waitMs}`,
  );
}

async function cliIntegersAndFilters() {
  const parser = await getParser(true);
  let port;
  let portError = '';
  try {
    port = parser.parseArgs(['--port', '4723abc']).port;
  } catch (err) {
    portError = err.message;
  }
  let filtersError = '';
  try {
    parser.parseArgs(['--log-filters', '[{"text":"password","replacer":"***"}]']);
  } catch (err) {
    filtersError = err.message.replace(/\u001b\[[0-9;]*m/g, '');
  }
  record(
    'integer CLI args keep a numeric prefix',
    port === 4723,
    portError ? portError.slice(0, 160) : `port=${port}`,
  );
  record(
    'inline --log-filters JSON is split on commas',
    /JSON|valid/i.test(filtersError),
    filtersError.slice(0, 220) || 'parse succeeded',
  );
}

async function allowInsecureFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'appium-allow-'));
  const file = path.join(dir, 'adb_shell');
  await writeFile(file, '*:adb_shell\n');
  const parser = await getParser(true);
  const cwd = process.cwd();
  process.chdir(dir);
  let value;
  let error = '';
  try {
    value = parser.parseArgs(['--allow-insecure', 'adb_shell']).allowInsecure;
  } catch (err) {
    error = err.message;
  } finally {
    process.chdir(cwd);
    await rm(dir, {recursive: true, force: true});
  }
  record(
    'a feature name that is also a file replaces the allow-list',
    Array.isArray(value) && value.includes('*:adb_shell') && !value.includes('adb_shell'),
    error || JSON.stringify(value),
  );
}

async function stickyFlag() {
  const preprocessor = new SecureValuesPreprocessor();
  await preprocessor.loadRules([{text: 's3cr3t', flags: 'y'}]);
  const out = preprocessor.preprocess('prefix s3cr3t suffix');
  record(
    'log filter flag y is combined with forced g and skips a non-prefix secret',
    out === 'prefix s3cr3t suffix',
    `flags=${preprocessor.rules[0].pattern.flags} output=${JSON.stringify(out)}`,
  );
}

async function copyFilterLastIndex() {
  const {filter: fn} = toCpOptions({filter: /keep/g});
  const answers = ['/tmp/keep-a', '/tmp/keep-b', '/tmp/keep-c'].map((p) => fn(p));
  record(
    'a global copy filter skips every other matching path',
    answers[0] === true && answers[1] === false && answers[2] === true,
    JSON.stringify(answers),
  );
}

async function mkdirOnFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'appium-mkdir-'));
  const file = path.join(dir, 'occupied');
  await writeFile(file, 'x');
  let threw = false;
  try {
    await fs.mkdir(file);
  } catch {
    threw = true;
  }
  const stillFile = (await import('node:fs/promises')).stat(file).then((s) => s.isFile());
  record(
    'fs.mkdir resolves when the path is an existing file',
    !threw && (await stillFile),
    `threw=${threw}`,
  );
  await rm(dir, {recursive: true, force: true});
}

function escapeAndWebhook() {
  const dotted = util.escapeSpecialChars('ab', '.');
  const bare = parseWebhookUri('::1');
  const bracketed = parseWebhookUri('[::1]:9003');
  record(
    'escapeSpecialChars treats the escape character as a regexp',
    dotted === '\\.\\.',
    JSON.stringify(dotted),
  );
  record(
    'legacy webhook host:port split mishandles IPv6',
    bare.host === '127.0.0.1' && bare.port === 9003 && bracketed.host === '[',
    `::1 -> ${JSON.stringify(bare)}; [::1]:9003 -> ${JSON.stringify(bracketed)}`,
  );
}

function proxyBaseSlash() {
  const proxy = new WebDriverProxy({server: '127.0.0.1', port: 9, reqBasePath: '/', base: '/', sessionId: 'proxy-session'});
  const url = proxy.getUrlForProxy('/session/abc/url', 'GET');
  record(
    'reqBasePath "/" doubles the session segment',
    url.includes('/session/proxy-session/session/abc/url'),
    url,
  );
}

function prototypePollution() {
  const before = Object.prototype.relaxedSecurityEnabled;
  const parsed = JSON.parse('{"__proto__":{"relaxedSecurityEnabled":true}}');
  defaultsDeep({}, parsed);
  const polluted = {}.relaxedSecurityEnabled === true;
  delete Object.prototype.relaxedSecurityEnabled;
  record(
    'defaultsDeep writes a JSON __proto__ object onto Object.prototype',
    polluted && before === undefined,
    `inherited relaxedSecurityEnabled was ${polluted}`,
  );
}

await firstMatchDuplicateKey();
await implicitNull();
await cliIntegersAndFilters();
await allowInsecureFile();
await stickyFlag();
await copyFilterLastIndex();
await mkdirOnFile();
escapeAndWebhook();
proxyBaseSlash();
prototypePollution();

const missed = results.filter((r) => !r.reproduced);
console.log(`\n${results.length - missed.length}/${results.length} follow-up bugs reproduced`);
if (missed.length) {
  process.exitCode = missed.length;
}
