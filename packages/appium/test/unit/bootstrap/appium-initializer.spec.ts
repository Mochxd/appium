import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {init} from '../../../lib/main.js';

describe('bootstrap/appium-initializer', function () {
  describe('showConfig', function () {
    it('should show config when a log filter is invalid and no number was coerced', async function (t) {
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'dir', () => {});
      const appiumHome = await mkdtemp(path.join(os.tmpdir(), 'appium-show-config-'));
      try {
        await init({
          appiumHome,
          showConfig: true,
          logFilters: [{pattern: '['}],
        });
      } finally {
        await rm(appiumHome, {recursive: true, force: true});
      }
    });
  });
});
