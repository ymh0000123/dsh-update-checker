'use strict';
/**
 * dsh-update-checker — installed (bundle) HOST half.
 *
 * Mounted by the loader when the package is installed into a profile:
 *
 *   dsh plugin --profile web add link:E:/dsh/1/dsh-update-checker
 *
 * `dsh.bundle.patch` (cordis.patch.yml) inserts this row; the loader requires
 * this main entry and uses its `name` + `apply` exports. The browser half
 * (client.js, exports["./client"]) talks to this half over a small local JSON
 * route instead of the dynamic-plugin `harness.handle` RPC.
 *
 * Both the check and the update are fire-and-forget background jobs whose state
 * the page polls: a single request must never block for minutes, which is what
 * made the dynamic variant fail with "Failed to fetch" on slow pnpm runs.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { runCheck, renderReport, findProfile } = require('./lib/check.js');
const { classifyPnpmFailure } = require('./lib/pnpm-error.js');
const { planAuthorization, authorizeBuild } = require('./lib/workspace-policy.js');

const NAME = 'dsh-update-checker';
const API_PATH = '/dsh-update-checker/api';
const CACHE_MS = 5 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function send(res, status, value) {
  const body = JSON.stringify(value === undefined ? null : value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + String(e.message)));
      }
    });
    req.on('error', reject);
  });
}

/** The web server binds browsers only; still refuse clearly non-local Host headers. */
function isLocalHost(host) {
  if (host === undefined || host === null) return false;
  const h = String(host).toLowerCase();
  return h.indexOf('127.0.0.1') === 0 || h.indexOf('localhost') === 0 || h.indexOf('[::1]') === 0 || h.indexOf('::1') === 0;
}

/** pnpm runs through a shell on Windows, so kill the whole tree, not just cmd.exe. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch (e) { /* fall through to signal */ }
  }
  try {
    child.kill('SIGTERM');
  } catch (e) { /* already gone */ }
}

/**
 * Load `defineTool` from the harness that is actually running.
 *
 * The profile is tried FIRST on purpose: a `link:` install resolves specifiers
 * from its own real path, so a bare import can silently pick up a second copy
 * of dsh-tools (a dev `node_modules/` beside this package) instead of the one
 * the runtime imported. Resolving from the profile names the same file, so the
 * ESM cache yields one shared module instance.
 */
async function loadDefineTool() {
  const profileDir = findProfile();
  if (profileDir) {
    try {
      const req = createRequire(path.join(profileDir, 'package.json'));
      const mod = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href);
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
    } catch (e) { /* fall through to the ordinary specifier */ }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
  } catch (e) { /* linked install: resolve from the profile instead */ }
  console.error(NAME + ': could not load @deepseek-ai/dsh-tools; the settings page still works but dsh_check_updates is unavailable');
  return null;
}

async function apply(ctx) {
  let cache = null;
  let inflight = null;
  let resultSeq = 0;
  let updateChild = null;
  let updateTimer = null;

  const progress = { active: false, phase: 'idle', current: 0, total: 0, message: '' };
  const updateState = { active: false, name: '', startedAt: 0, line: '', cancelled: false, authorized: false, result: null };

  // ---- detection ---------------------------------------------------------

  const startCheck = (force) => {
    if (inflight) return { accepted: true, running: true };
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return { accepted: true, cached: true, resultAt: cache.at };
    progress.active = true;
    progress.phase = 'init';
    progress.current = 0;
    progress.total = 1;
    progress.message = '正在启动检查…';
    inflight = (async () => {
      try {
        const report = await runCheck((phase, current, total, message) => {
          progress.phase = phase;
          progress.current = current;
          progress.total = total;
          progress.message = message || '';
        });
        cache = { at: Date.now(), report };
      } catch (e) {
        cache = { at: Date.now(), report: { ok: false, error: String((e && e.message) || e) } };
      } finally {
        progress.active = false;
        inflight = null;
      }
    })();
    return { accepted: true, started: true };
  };

  const awaitCheck = async (force) => {
    startCheck(force);
    const pending = inflight;
    if (pending) {
      try {
        await pending;
      } catch (e) { /* failure is recorded in cache */ }
    }
    return (cache && cache.report) || { ok: false, error: '检查未产生结果' };
  };

  // ---- one-click update --------------------------------------------------

  const finishUpdate = (name, startedAt, payload) => {
    resultSeq += 1;
    updateState.result = Object.assign(
      { seq: resultSeq, name, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt },
      payload,
    );
    updateState.active = false;
    updateChild = null;
    if (updateTimer !== null) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
  };

  /** Describe the supply-chain grant an authorized update would write. */
  const authorizePlan = (name) => {
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) return { ok: false, message: '包名无效' };
    const report = cache && cache.report;
    const profileDir = report && report.profilePath;
    if (!profileDir) return { ok: false, message: '未找到 profile 目录，请先执行一次检测' };
    const gpkg = ((report && report.github) || []).find((p) => p.name === name);
    if (!gpkg) return { ok: false, message: '未找到该 GitHub 源包：' + name };
    if (gpkg.kind !== 'github-dep') return { ok: false, message: '该包为本地 link 安装，请手动在仓库目录执行 git pull' };
    if (!gpkg.latestCommit) return { ok: false, message: '还不知道该包的最新 commit，请先重新检测' };
    const plan = planAuthorization({ profileDir, name, repo: gpkg.repo, sha: gpkg.latestCommit });
    return {
      ok: plan.ok,
      message: plan.error,
      name,
      repo: gpkg.repo,
      commit: gpkg.latestCommit,
      installedCommit: gpkg.installedCommit || null,
      file: plan.file,
      line: plan.key + ': true',
      tarball: plan.tarball,
      alreadyAllowed: plan.alreadyAllowed,
      replaces: plan.replaces,
      spec: name + '@' + plan.tarball,
    };
  };

  /**
   * Start an update.
   *
   * Plain mode runs `pnpm update <name>`: it keeps the `github:` shorthand, but
   * needs github.com's git channel to resolve and fetch the commit.
   *
   * Authorized mode is the escalation the panel makes the user confirm. It
   * installs the pinned codeload tarball, which needs no git channel — and only
   * if pnpm then refuses because the commit may not run its build scripts does
   * it write the allowBuilds grant and retry. A package that needs no build
   * therefore never gets a needless policy grant.
   */
  const startUpdate = (name, authorize) => {
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) return { ok: false, message: '包名无效' };
    if (updateState.active) return { ok: false, message: '已有更新正在进行：' + updateState.name };
    const report = cache && cache.report;
    const profileDir = report && report.profilePath;
    if (!profileDir) return { ok: false, message: '未找到 profile 目录，请先执行一次检测' };
    const gpkg = ((report && report.github) || []).find((p) => p.name === name);
    if (!gpkg) return { ok: false, message: '未找到该 GitHub 源包：' + name };
    if (gpkg.kind !== 'github-dep') return { ok: false, message: '该包为本地 link 安装，请手动在仓库目录执行 git pull' };
    if (!gpkg.hasUpdate) return { ok: false, message: '该包已是最新，无需更新' };
    if (authorize === true && !gpkg.latestCommit) return { ok: false, message: '还不知道该包的最新 commit，请先重新检测' };

    const startedAt = Date.now();
    updateState.active = true;
    updateState.name = name;
    updateState.startedAt = startedAt;
    updateState.line = authorize === true ? '正在安装固定 commit…' : '';
    updateState.cancelled = false;
    updateState.result = null;
    updateState.authorized = false;
    updateChild = null;

    updateTimer = setTimeout(() => {
      updateState.cancelled = true;
      updateState.line = '超时，正在终止…';
      if (updateChild) killTree(updateChild);
    }, UPDATE_TIMEOUT_MS);
    if (updateTimer.unref) updateTimer.unref();

    /** Run one pnpm invocation, streaming its progress line into updateState. */
    const runPnpm = (argv) => new Promise((resolve) => {
      let child;
      try {
        child = spawn('pnpm', argv, { cwd: profileDir, shell: true, windowsHide: true });
      } catch (e) {
        resolve({ spawnError: String((e && e.message) || e) });
        return;
      }
      updateChild = child;
      let out = '';
      let err = '';
      const track = (chunk) => {
        for (const line of String(chunk).split('\n')) {
          const t = line.trim();
          if (t.indexOf('Progress:') === 0 || t.indexOf('Packages:') === 0 || t.indexOf('Already up to date') === 0) {
            updateState.line = t.slice(0, 200);
          }
        }
      };
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (out.length < 300 * 1024) out += chunk;
          track(chunk);
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          if (err.length < 100 * 1024) err += chunk;
          track(chunk);
        });
      }
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        updateChild = null;
        resolve(value);
      };
      child.on('error', (e) => settle({ spawnError: String((e && e.message) || e) }));
      child.on('close', (code) => settle({ code, out, err }));
    });

    (async () => {
      const tarball = gpkg.latestCommit ? 'https://codeload.github.com/' + gpkg.repo + '/tar.gz/' + gpkg.latestCommit : null;
      let granted = false;
      let attempt = authorize === true
        ? await runPnpm(['add', name + '@' + tarball])
        : await runPnpm(['update', name]);

      // The one place a policy grant is written: pnpm just said this commit is
      // not allowed to build, and the user already confirmed that exact line.
      if (authorize === true && !updateState.cancelled && attempt.code !== 0 && attempt.spawnError === undefined) {
        const failure = classifyPnpmFailure({ stdout: attempt.out, stderr: attempt.err, code: attempt.code, name });
        if (failure.kind === 'allow-builds' || failure.kind === 'ignored-build-scripts') {
          const grant = authorizeBuild({ profileDir, name, repo: gpkg.repo, sha: gpkg.latestCommit });
          if (!grant.ok) {
            finishUpdate(name, startedAt, { ok: false, kind: 'allow-builds', message: grant.error || '写入 allowBuilds 失败' });
            return;
          }
          granted = true;
          updateState.authorized = true;
          updateState.line = '已授权构建，正在重新安装…';
          attempt = await runPnpm(['add', name + '@' + tarball]);
        }
      }

      if (updateState.cancelled) {
        finishUpdate(name, startedAt, { ok: false, cancelled: true, message: '已停止 ' + name + ' 的更新' });
        return;
      }
      if (attempt.spawnError !== undefined) {
        finishUpdate(name, startedAt, { ok: false, message: 'pnpm 执行失败: ' + attempt.spawnError });
        return;
      }
      if (attempt.code !== 0) {
        const failure = classifyPnpmFailure({ stdout: attempt.out, stderr: attempt.err, code: attempt.code, name });
        finishUpdate(name, startedAt, {
          ok: false,
          kind: failure.kind,
          detail: failure.detail,
          message: failure.message,
          // A build-script block or a dead git channel is fixable from the panel
          // by granting this one commit; anything else is not.
          canAuthorize: authorize !== true
            && (failure.kind === 'allow-builds' || failure.kind === 'ignored-build-scripts' || failure.kind === 'github-git-unreachable'),
        });
        return;
      }

      // Keep the cached report consistent so the row stops offering the update.
      if (gpkg.latestCommit) {
        gpkg.installedCommit = gpkg.latestCommit;
        gpkg.hasUpdate = false;
        const gs = report.githubSummary;
        if (gs) {
          gs.updatable = Math.max(0, (gs.updatable || 0) - 1);
          gs.upToDate = (gs.upToDate || 0) + 1;
        }
      }
      const short = String(gpkg.latestCommit || '').slice(0, 7);
      let message;
      if (authorize !== true) {
        message = '已将 ' + name + ' 更新到最新 commit（重启 DSH 后完全生效）';
      } else {
        message = (granted ? '已授权构建并把 ' : '已把 ') + name + ' 更新到 ' + short
          + '（重启 DSH 后完全生效）。该依赖现已固定为此 commit；github.com 的 git 通道恢复后可用 '
          + 'dsh plugin --profile web add github:' + gpkg.repo + ' 还原为跟随最新。'
          + (granted ? '' : ' 该包无需构建脚本，因此没有写入任何 allowBuilds 授权。');
      }
      finishUpdate(name, startedAt, { ok: true, authorized: granted, pinned: authorize === true, message });
    })();

    return { ok: true, started: true, name };
  };

  // ---- request router ----------------------------------------------------

  const run = async (args) => {
    const action = args && args.action ? String(args.action) : 'progress';
    if (action === 'check') return startCheck(!!(args && args.force));
    if (action === 'progress') {
      return {
        active: progress.active,
        phase: progress.phase,
        current: progress.current,
        total: progress.total,
        message: progress.message,
        resultAt: cache ? cache.at : 0,
      };
    }
    if (action === 'report') return cache ? cache.report : null;
    if (action === 'update') return startUpdate(args && args.name, !!(args && args.authorize));
    if (action === 'authorize-plan') return authorizePlan(args && args.name);
    if (action === 'update-progress') {
      return {
        active: updateState.active,
        name: updateState.name,
        elapsedMs: updateState.active ? Date.now() - updateState.startedAt : 0,
        line: updateState.line,
        authorized: !!updateState.authorized,
        cancelling: !!(updateState.active && updateState.cancelled),
        result: updateState.result,
      };
    }
    if (action === 'cancel') {
      if (updateState.active && updateChild) {
        updateState.cancelled = true;
        killTree(updateChild);
        return { ok: true, message: '已请求停止更新' };
      }
      return { ok: false, message: '当前没有正在进行的更新' };
    }
    return { ok: false, error: 'unknown action "' + action + '"' };
  };

  // ---- model tool --------------------------------------------------------

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const defineTool = await loadDefineTool();
    if (defineTool !== null) {
      ctx.effect(() => tools.register(defineTool({
        name: 'dsh_check_updates',
        description: '检查本机安装的 DSH / @deepseek-ai 各包（npm 源）及 GitHub 源包相对仓库的更新情况。npm 部分返回每个包的本机版本(local)、稳定版标签(latest)、预发布标签(next)、已发布最高版本(maxPublished)、是否有更新(hasUpdate)；GitHub 部分返回仓库(repo)、已安装 commit(installedCommit)、远程默认分支最新 commit(latestCommit)、是否有更新(hasUpdate)。附 DSH 发行版号(dshRelease)与汇总(summary / githubSummary)。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
        },
        async execute() {
          return awaitCheck(true);
        },
      })));
    }
  }

  // ---- browser JSON route -----------------------------------------------

  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        if (!isLocalHost(req.headers.host)) return send(res, 403, { ok: false, error: 'forbidden' });
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
        let args;
        try {
          args = await readBody(req);
        } catch (e) {
          return send(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
        try {
          send(res, 200, await run(args));
        } catch (e) {
          send(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
  }

  // Never leave a pnpm run (or its timer) behind when this row unmounts.
  ctx.effect(() => () => {
    if (updateTimer !== null) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (updateChild) {
      killTree(updateChild);
      updateChild = null;
    }
    updateState.active = false;
    progress.active = false;
  });

  console.log(NAME + ' ready: settings page + dsh_check_updates tool');
}

module.exports = {
  name: NAME,
  inject: ['tools', 'webServer'],
  apply,
};
