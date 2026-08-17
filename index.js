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

/** Pull the first meaningful error line out of a noisy pnpm log. */
function extractErr(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  const idx = lines.findIndex((l) => l.indexOf('ERR_') === 0 || l.indexOf('error') === 0 || l.indexOf('Error') === 0 || l.indexOf('ERROR') === 0);
  if (idx >= 0) return lines.slice(idx, idx + 3).join(' | ').slice(0, 300);
  return lines[0].slice(0, 200);
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
 * A `link:` install lives outside the profile, and Node resolves specifiers from
 * a file's real path, so the bare import only works for a package installed
 * inside the profile (github:/registry). Fall back to resolving from the
 * profile directory, which is the same file the runtime already imported, so
 * the ESM cache hands back one shared module instance either way.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
  } catch (e) { /* linked install: resolve from the profile instead */ }
  const profileDir = findProfile();
  if (!profileDir) return null;
  try {
    const req = createRequire(path.join(profileDir, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href);
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
  } catch (e) {
    console.error(NAME + ': could not load @deepseek-ai/dsh-tools; the settings page still works but dsh_check_updates is unavailable: ' + String((e && e.message) || e));
  }
  return null;
}

async function apply(ctx) {
  let cache = null;
  let inflight = null;
  let resultSeq = 0;
  let updateChild = null;
  let updateTimer = null;

  const progress = { active: false, phase: 'idle', current: 0, total: 0, message: '' };
  const updateState = { active: false, name: '', startedAt: 0, line: '', cancelled: false, result: null };

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

  const startUpdate = (name) => {
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) return { ok: false, message: '包名无效' };
    if (updateState.active) return { ok: false, message: '已有更新正在进行：' + updateState.name };
    const report = cache && cache.report;
    const profileDir = report && report.profilePath;
    if (!profileDir) return { ok: false, message: '未找到 profile 目录，请先执行一次检测' };
    const gpkg = ((report && report.github) || []).find((p) => p.name === name);
    if (!gpkg) return { ok: false, message: '未找到该 GitHub 源包：' + name };
    if (gpkg.kind !== 'github-dep') return { ok: false, message: '该包为本地 link 安装，请手动在仓库目录执行 git pull' };
    if (!gpkg.hasUpdate) return { ok: false, message: '该包已是最新，无需更新' };

    let child;
    try {
      child = spawn('pnpm', ['update', name], { cwd: profileDir, shell: true, windowsHide: true });
    } catch (e) {
      return { ok: false, message: 'pnpm 启动失败: ' + String((e && e.message) || e) };
    }

    const startedAt = Date.now();
    updateState.active = true;
    updateState.name = name;
    updateState.startedAt = startedAt;
    updateState.line = '';
    updateState.cancelled = false;
    updateState.result = null;
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

    updateTimer = setTimeout(() => {
      updateState.cancelled = true;
      updateState.line = '超时，正在终止…';
      killTree(child);
    }, UPDATE_TIMEOUT_MS);
    if (updateTimer.unref) updateTimer.unref();

    child.on('error', (e) => {
      finishUpdate(name, startedAt, { ok: false, message: 'pnpm 执行失败: ' + String((e && e.message) || e) });
    });

    child.on('close', (code) => {
      if (updateState.result !== null && updateState.result.name === name && !updateState.active) return;
      if (updateState.cancelled) {
        finishUpdate(name, startedAt, { ok: false, cancelled: true, message: '已停止 ' + name + ' 的更新' });
        return;
      }
      if (code !== 0) {
        const detail = extractErr(err) || extractErr(out) || '未知错误';
        finishUpdate(name, startedAt, {
          ok: false,
          message: '更新失败（退出码 ' + String(code) + '）：' + detail + '。若是网络问题（github.com 连不上），网络恢复后重试',
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
      finishUpdate(name, startedAt, { ok: true, message: '已将 ' + name + ' 更新到最新 commit（重启 DSH 后完全生效）' });
    });

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
    if (action === 'update') return startUpdate(args && args.name);
    if (action === 'update-progress') {
      return {
        active: updateState.active,
        name: updateState.name,
        elapsedMs: updateState.active ? Date.now() - updateState.startedAt : 0,
        line: updateState.line,
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
