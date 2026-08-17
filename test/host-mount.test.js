'use strict';
/**
 * Mount the installed HOST half against a stub Cordis context and exercise the
 * browser JSON route end to end. This is the check that does not need a running
 * `dsh web`: it proves the row's exports, its tool registration, its local API
 * and its disposer, plus that `@deepseek-ai/dsh-tools` resolves even from a
 * `link:` install outside the profile.
 *
 *   node --test test/host-mount.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const plugin = require('../index.js');

/**
 * Minimal ctx: get() for services, effect() running the callback eagerly, and
 * inject() mirroring cordis. `offer` selects which services exist, so the
 * tui/headless composition (no webServer) can be exercised too.
 */
function stubCtx(offer) {
  const registered = { tools: [], routes: [], disposers: [] };
  const wanted = offer === undefined ? ['tools', 'webServer'] : offer;
  const services = {};
  if (wanted.indexOf('tools') >= 0) {
    services.tools = {
      register(tool) {
        registered.tools.push(tool);
        return () => { registered.tools.splice(registered.tools.indexOf(tool), 1); };
      },
    };
  }
  if (wanted.indexOf('webServer') >= 0) {
    services.webServer = {
      register(route) {
        registered.routes.push(route);
        return () => { registered.routes.splice(registered.routes.indexOf(route), 1); };
      },
    };
  }
  const ctx = {
    get(name) {
      return services[name];
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') registered.disposers.push(disposer);
      return () => {};
    },
    // Mirror cordis: the callback runs only once every declared dependency is
    // available, and it receives a scope exposing them.
    inject(deps, callback) {
      if (!deps.every((dep) => services[dep] !== undefined)) return {};
      const scope = {
        get(name) { return services[name]; },
        effect(cb) {
          const disposer = cb();
          if (typeof disposer === 'function') registered.disposers.push(disposer);
          return () => {};
        },
      };
      for (const dep of deps) scope[dep] = services[dep];
      callback(scope);
      return {};
    },
  };
  return { ctx, registered };
}

/** Drive the registered prefix route the way the browser does. */
function invoke(route, body) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.method = 'POST';
    req.headers = { host: '127.0.0.1:3080' };
    req.push(JSON.stringify(body));
    req.push(null);
    const res = {
      writeHead() {},
      end(text) {
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('exports a cordis plugin row', () => {
  assert.equal(plugin.name, 'dsh-update-checker');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.inject, undefined, 'no hard dependency: each half mounts through its own ctx.inject');
});

test('on a profile without a web server, the tool still registers', async () => {
  // tui / headless: the row used to wait for webServer forever and contribute
  // nothing at all, not even the model tool.
  const { ctx, registered } = stubCtx(['tools']);
  await plugin.apply(ctx);
  assert.equal(registered.tools.length, 1, 'the model tool must not depend on the web server');
  assert.equal(registered.tools[0].name, 'dsh_check_updates');
  assert.equal(registered.routes.length, 0, 'no web server, no route');
  for (const dispose of registered.disposers) dispose();
});

test('with neither service, mounting is still harmless', async () => {
  const { ctx, registered } = stubCtx([]);
  await plugin.apply(ctx);
  assert.equal(registered.tools.length, 0);
  assert.equal(registered.routes.length, 0);
  for (const dispose of registered.disposers) dispose();
});

test('mounts, serves the local API and disposes', async () => {
  const { ctx, registered } = stubCtx();
  await plugin.apply(ctx);

  assert.equal(registered.routes.length, 1, 'one browser route');
  assert.equal(registered.routes[0].path, '/dsh-update-checker/api');
  assert.equal(registered.routes[0].kind, 'prefix');

  assert.equal(registered.tools.length, 1, 'dsh_check_updates registered');
  assert.equal(registered.tools[0].name, 'dsh_check_updates');

  const route = registered.routes[0];

  // A method other than POST is refused rather than acted on.
  const bad = await new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = 'GET';
    req.headers = { host: '127.0.0.1' };
    req.push(null);
    route.handler(req, { writeHead() {}, end: (t) => resolve(JSON.parse(t)) });
  });
  assert.equal(bad.ok, false);

  // Starting a check returns immediately: no request may block for minutes.
  const started = await invoke(route, { action: 'check', force: true });
  assert.equal(started.accepted, true);

  let progress = await invoke(route, { action: 'progress' });
  assert.equal(progress.active, true, 'check runs in the background');

  const deadline = Date.now() + 120000;
  while (progress.active && Date.now() < deadline) {
    await sleep(300);
    progress = await invoke(route, { action: 'progress' });
  }
  assert.equal(progress.active, false, 'check finished');
  assert.ok(progress.resultAt > 0, 'a report timestamp is published');

  const report = await invoke(route, { action: 'report' });
  assert.equal(report.ok, true, 'report: ' + JSON.stringify(report && report.error));
  assert.ok(Array.isArray(report.packages) && report.packages.length > 0, 'npm packages detected');
  assert.ok(report.summary && typeof report.summary.updatable === 'number');
  assert.ok(Array.isArray(report.github), 'github section present');
  assert.equal(typeof report.profilePath, 'string');

  // An unknown package cannot start a pnpm run.
  const bogus = await invoke(route, { action: 'update', name: 'not-a-real-package' });
  assert.equal(bogus.ok, false);

  // Nor can a shell metacharacter reach the spawn.
  const unsafe = await invoke(route, { action: 'update', name: 'x && calc' });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.message, '包名无效');

  const idleUpdate = await invoke(route, { action: 'update-progress' });
  assert.equal(idleUpdate.active, false);
  assert.equal(idleUpdate.result, null);

  // The supply-chain grant is planned by a read-only action, never applied here.
  const noPlan = await invoke(route, { action: 'authorize-plan', name: 'not-a-real-package' });
  assert.equal(noPlan.ok, false);

  const candidate = (report.github || []).find((g) => g.kind === 'github-dep' && g.latestCommit);
  if (candidate !== undefined) {
    const plan = await invoke(route, { action: 'authorize-plan', name: candidate.name });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.commit, candidate.latestCommit);
    assert.ok(plan.file.endsWith('pnpm-workspace.yaml'), plan.file);
    assert.ok(plan.line.endsWith(': true'), plan.line);
    assert.ok(plan.line.includes('codeload.github.com/' + candidate.repo + '/tar.gz/' + candidate.latestCommit), plan.line);
    assert.equal(plan.spec, candidate.name + '@' + plan.tarball);
  }

  const noCancel = await invoke(route, { action: 'cancel' });
  assert.equal(noCancel.ok, false);

  const unknown = await invoke(route, { action: 'nope' });
  assert.equal(unknown.ok, false);

  for (const dispose of registered.disposers) dispose();
});
