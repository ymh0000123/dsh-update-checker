// Host half of the "DSH 更新检测" dynamic Cordis plugin (updt-1 / pkg-7).
// This is the exact `code.host` body, wrapped as an ES module default export
// so it can live in a normal package repo.
// To load it as a dynamic plugin via cordis_define, use the function body
// (the part inside `export default function () { ... }`) as code.host.
export default function () {
const SCRIPT = String.raw`
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const home = os.homedir();
const profilesRoot = path.join(home, '.dsh', 'profiles');

function findProfile() {
  if (!fs.existsSync(profilesRoot)) return null;
  let dirs = [];
  try {
    dirs = fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(profilesRoot, d.name));
  } catch (e) { return null; }
  const withPackages = dirs.filter((d) => fs.existsSync(path.join(d, 'node_modules', '@deepseek-ai')));
  if (withPackages.length === 0) return null;
  const web = withPackages.filter((d) => fs.existsSync(path.join(d, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')));
  return (web.length ? web[0] : withPackages[0]);
}

function readLocalPackages(profileDir) {
  const scoped = path.join(profileDir, 'node_modules', '@deepseek-ai');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(scoped); } catch (e) { return out; }
  for (const name of names) {
    const pj = path.join(scoped, name, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (meta && typeof meta.version === 'string') out.push({ name: '@deepseek-ai/' + name, local: meta.version });
    } catch (e) { /* skip */ }
  }
  return out;
}

function readInstalledVersion(profileDir, name) {
  const pj = path.join(profileDir, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pj)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return meta && typeof meta.version === 'string' ? meta.version : undefined;
  } catch (e) { return undefined; }
}

function gitRun(args) {
  return new Promise((resolve) => {
    execFile('git', args, { encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve({ error: String((stderr && stderr.trim()) || (err && err.message) || 'git failed') });
      else resolve({ output: String(stdout || '').trim() });
    });
  });
}

function emitProgress(phase, done, total, message) {
  process.stderr.write('PROGRESS\t' + phase + '\t' + done + '\t' + total + '\t' + (message || '') + '\n');
}

function githubRepoFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = /github\.com[:\/]([^\/]+)\/([^\/\s]+?)(?:\.git)?$/.exec(url.replace(/^git\+/, ''));
  if (!m) return null;
  return m[1] + '/' + m[2].replace(/\.git$/, '');
}

function parseGithubFromLockfile(profileDir) {
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return [];
  let text = '';
  try { text = fs.readFileSync(lockPath, 'utf8'); } catch (e) { return []; }
  const re = /^  ['"]?((?:@[^\/]+\/)?[^@'"\r\n]+)@https:\/\/codeload\.github\.com\/([^\/]+)\/([^\/]+)\/tar\.gz\/([0-9a-f]{40})/gm;
  const seen = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.set(name, {
      name,
      repo: m[2] + '/' + m[3],
      installedCommit: m[4],
      kind: 'github-dep',
      local: readInstalledVersion(profileDir, name),
    });
  }
  return Array.from(seen.values());
}

function findLinkDeps(profileDir) {
  const pjPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pjPath)) return [];
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch (e) { return []; }
  const out = [];
  const all = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  for (const name of Object.keys(all)) {
    const spec = all[name];
    if (typeof spec !== 'string' || spec.indexOf('link:') !== 0) continue;
    let target = spec.slice(5);
    if (!path.isAbsolute(target)) target = path.join(profileDir, target);
    out.push({ name, target });
  }
  return out;
}

async function gitInfoForLink(dep) {
  const head = await gitRun(['-C', dep.target, 'rev-parse', 'HEAD']);
  if (head.error) return { name: dep.name, kind: 'link-git', error: '非 git 仓库: ' + head.error };
  const remote = await gitRun(['-C', dep.target, 'remote', 'get-url', 'origin']);
  if (remote.error) return { name: dep.name, kind: 'link-git', error: '无 origin 远程: ' + remote.error };
  const repo = githubRepoFromUrl(remote.output);
  if (!repo) return { name: dep.name, kind: 'link-git', error: 'origin 非 GitHub: ' + remote.output };
  let local;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dep.target, 'package.json'), 'utf8'));
    local = meta && typeof meta.version === 'string' ? meta.version : undefined;
  } catch (e) { local = undefined; }
  return { name: dep.name, kind: 'link-git', repo, installedCommit: head.output.trim(), local };
}

async function checkGithub(items) {
  const total = items.length;
  let done = 0;
  return mapLimit(items, 4, async (p) => {
    if (p.error) {
      done++;
      emitProgress('github', done, total, p.repo + '（跳过）');
      return Object.assign({}, p, { hasUpdate: false, latestCommit: null });
    }
    const r = await gitRun(['ls-remote', 'https://github.com/' + p.repo + '.git', 'HEAD']);
    if (r.error) {
      done++;
      emitProgress('github', done, total, p.repo + '（失败）');
      return Object.assign({}, p, { hasUpdate: false, latestCommit: null, error: r.error });
    }
    const latest = (r.output.split(/\s+/)[0] || '').trim();
    done++;
    emitProgress('github', done, total, p.repo);
    return Object.assign({}, p, { latestCommit: latest, hasUpdate: !!latest && latest !== p.installedCommit });
  });
}

function parseV(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { core: [m[1] || '0', m[2] || '0', m[3] || '0'].map(Number), pre: m[4] ? m[4].split('.') : null };
}
function cmp(a, b) {
  const A = parseV(a), B = parseV(b);
  if (!A || !B) { const sa = String(a || ''), sb = String(b || ''); return sa < sb ? -1 : sa > sb ? 1 : 0; }
  for (let i = 0; i < 3; i++) { if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1; }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function maxOf(list) {
  let best = null;
  for (const v of list) if (best === null || cmp(v, best) > 0) best = v;
  return best;
}

async function fetchInfo(pkg) {
  const url = 'https://registry.npmjs.org/' + pkg.name.replace('/', '%2F');
  const res = await fetch(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return Object.assign({}, pkg, { error: 'HTTP ' + res.status });
  const doc = await res.json();
  const tags = (doc && doc['dist-tags']) || {};
  const versions = Object.keys((doc && doc.versions) || {});
  const max = maxOf(versions);
  return Object.assign({}, pkg, {
    latest: tags.latest || null,
    next: tags.next || null,
    maxPublished: max,
    hasUpdate: max !== null && cmp(max, pkg.local) > 0,
    publishedCount: versions.length,
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i]); }
      catch (e) { results[i] = Object.assign({}, items[i], { error: String((e && e.message) || e) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return results;
}

(async function main() {
  const profileDir = findProfile();
  emitProgress('init', 0, 1, profileDir ? '已找到 profile: ' + profileDir : '未找到 profile');
  const local = profileDir ? readLocalPackages(profileDir) : [];
  const dshVersions = local.filter((p) => p.name.indexOf('@deepseek-ai/dsh-') === 0).map((p) => p.local);
  const dshRelease = maxOf(dshVersions) || null;
  const checked = local.slice();
  if (dshRelease) checked.push({ name: '@deepseek-ai/dsh', local: dshRelease, synthetic: true });
  const npmTotal = checked.length;
  emitProgress('npm', 0, npmTotal, '开始查询 npm 仓库（共 ' + npmTotal + ' 个包）');
  let npmDone = 0;
  const packages = await mapLimit(checked, 8, async (p) => {
    const r = await fetchInfo(p);
    npmDone++;
    emitProgress('npm', npmDone, npmTotal, p.name);
    return r;
  });
  const summary = { total: packages.length, updatable: 0, upToDate: 0, preview: 0, failed: 0 };
  for (const p of packages) {
    if (p.error) { summary.failed++; continue; }
    if (p.hasUpdate) { summary.updatable++; continue; }
    if (p.local === p.latest) { summary.upToDate++; continue; }
    summary.preview++;
  }

  let github = [];
  if (profileDir) {
    github = parseGithubFromLockfile(profileDir);
    const links = findLinkDeps(profileDir);
    for (const link of links) github.push(await gitInfoForLink(link));
  }
  emitProgress('github', 0, github.length, '开始检查 GitHub 仓库（共 ' + github.length + ' 个）');
  github = await checkGithub(github);
  const githubSummary = { total: github.length, updatable: 0, upToDate: 0, failed: 0 };
  for (const p of github) {
    if (p.error) { githubSummary.failed++; continue; }
    if (p.hasUpdate) { githubSummary.updatable++; continue; }
    githubSummary.upToDate++;
  }
  emitProgress('done', 1, 1, '检查完成');

  process.stdout.write(JSON.stringify({ ok: true, home, profilePath: profileDir, dshRelease, checkedAt: new Date().toISOString(), summary, packages, github, githubSummary }));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e), home }));
});
`;

const renderReport = (value) => {
  if (!value || value.ok !== true) {
    return '更新检测失败: ' + ((value && value.error) || '未知错误');
  }
  const s = value.summary || {};
  const lines = [];
  lines.push('DSH 版本: ' + (value.dshRelease || '未知'));
  lines.push('Profile: ' + (value.profilePath || '未找到'));
  lines.push('检查时间: ' + (value.checkedAt || ''));
  lines.push('npm 包: 共 ' + s.total + ' | 可更新 ' + s.updatable + ' | 已最新 ' + s.upToDate + ' | 预发布(next) ' + s.preview + ' | 失败 ' + s.failed);
  const updates = (value.packages || []).filter((p) => p.hasUpdate);
  if (updates.length > 0) {
    lines.push('npm 可更新包:');
    for (const p of updates) lines.push('  - ' + p.name + ': ' + p.local + ' -> ' + p.maxPublished + (p.next ? ' (next=' + p.next + ')' : ''));
  }
  const gs = value.githubSummary || {};
  if (value.github && value.github.length > 0) {
    lines.push('GitHub 源包: 共 ' + gs.total + ' | 可更新 ' + gs.updatable + ' | 已最新 ' + gs.upToDate + ' | 失败 ' + gs.failed);
    const gUpdates = value.github.filter((p) => p.hasUpdate);
    if (gUpdates.length > 0) {
      lines.push('GitHub 可更新包:');
      for (const p of gUpdates) {
        lines.push('  - ' + p.name + ' (' + p.repo + '): ' + String(p.installedCommit).slice(0, 8) + ' -> ' + String(p.latestCommit).slice(0, 8));
      }
    }
  } else {
    lines.push('GitHub 源包: 无');
  }
  return lines.join('\n');
};

return {
  apply(ctx) {
    const fs = ctx.get('fs');
    const sub = ctx.get('subprocess');
    const timer = ctx.get('timer');

    let cache = null;
    let inflight = null;
    const progress = { active: false, phase: 'idle', current: 0, total: 0, message: '' };

    const doCheck = async () => {
      if (!sub) return { ok: false, error: 'subprocess 服务不可用（无法运行检测）' };
      let cwd = '.';
      if (fs) {
        try {
          const target = await fs.resolve('.');
          cwd = fs.processPath(target);
        } catch (e) { /* keep '.' */ }
      }
      let nodePath;
      try {
        nodePath = await sub.resolveExecutable('node');
      } catch (e) {
        return { ok: false, error: '无法解析 node 可执行文件: ' + String((e && e.message) || e) };
      }
      let handle;
      try {
        handle = sub.spawn({
          argv: [nodePath, '-'],
          cwd: cwd,
          stdio: {
            stdin: { data: SCRIPT },
            stdout: { maxBytes: 2 * 1024 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
            stderr: { maxBytes: 200 * 1024 },
          },
          graceMs: 15000,
        });
      } catch (e) {
        return { ok: false, error: 'spawn 失败: ' + String((e && e.message) || e) };
      }

      let stderrOffset = 0;
      const drain = () => {
        const reader = handle.collected && handle.collected.stderr;
        if (!reader) return;
        let read;
        try { read = reader.readFrom(stderrOffset); } catch (e) { return; }
        stderrOffset = read.nextOffset;
        if (!read.text) return;
        const lines = String(read.text).split('\n');
        for (const line of lines) {
          if (line.indexOf('PROGRESS\t') !== 0) continue;
          const parts = line.split('\t');
          if (parts.length < 5) continue;
          progress.phase = parts[1];
          progress.current = Number(parts[2]) || 0;
          progress.total = Number(parts[3]) || 0;
          progress.message = parts.slice(4).join('\t');
        }
      };

      const outcome = handle.done;
      if (timer) {
        for (;;) {
          drain();
          const r = await Promise.race([outcome.then(() => 'done'), timer.timeout(150)]);
          if (r === 'done') break;
        }
      } else {
        await outcome;
      }
      drain();

      let exitCode;
      try {
        exitCode = (await outcome).exitCode;
      } catch (e) {
        return { ok: false, error: '子进程启动失败: ' + String((e && e.message) || e) };
      }
      const out = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : '';
      const err = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : '';
      if (exitCode !== 0) {
        return { ok: false, error: '检查器退出码 ' + String(exitCode) + ': ' + String(err).slice(-600) };
      }
      try {
        return JSON.parse(out);
      } catch (e) {
        return { ok: false, error: '检查器输出解析失败: ' + String((e && e.message) || e) + ' :: ' + String(out).slice(0, 600) };
      }
    };

    const runCheck = async (force) => {
      if (!force && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.report;
      if (inflight) return inflight;
      inflight = (async () => {
        progress.active = true;
        progress.phase = 'init';
        progress.current = 0;
        progress.total = 1;
        progress.message = '正在启动检查…';
        try {
          const report = await doCheck();
          cache = { at: Date.now(), report };
          return report;
        } finally {
          progress.active = false;
          inflight = null;
        }
      })();
      return inflight;
    };

    harness.handle('check-updates', async (args) => {
      try {
        return await runCheck(!!(args && args.force));
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });

    harness.handle('check-progress', async () => ({
      active: progress.active,
      phase: progress.phase,
      current: progress.current,
      total: progress.total,
      message: progress.message,
    }));

    harness.handle('perform-update', async (args) => {
      try {
        const name = args && args.name;
        if (!name) return { ok: false, message: '缺少包名' };
        if (!sub) return { ok: false, message: 'subprocess 服务不可用' };
        const report = cache && cache.report;
        const profileDir = report && report.profilePath;
        if (!profileDir) return { ok: false, message: '未找到 profile 目录，请先执行一次检测' };
        const gpkg = ((report && report.github) || []).find((p) => p.name === name);
        if (!gpkg) return { ok: false, message: '未找到该 GitHub 源包：' + String(name) };
        if (gpkg.kind !== 'github-dep') return { ok: false, message: '该包为本地 link 安装，请手动在仓库目录执行 git pull' };
        if (!gpkg.hasUpdate) return { ok: false, message: '该包已是最新，无需更新' };

        let argv;
        let cmdPath = null;
        try { cmdPath = await sub.resolveExecutable('cmd'); } catch (e) { cmdPath = null; }
        if (cmdPath) {
          argv = [cmdPath, '/c', 'pnpm update ' + name];
        } else {
          const pnpmPath = await sub.resolveExecutable('pnpm');
          argv = [pnpmPath, 'update', name];
        }
        const handle = sub.spawn({
          argv: argv,
          cwd: profileDir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 300 * 1024, spill: { maxBytes: 600 * 1024 } },
            stderr: { maxBytes: 100 * 1024 },
          },
          graceMs: 180000,
        });
        let outcome;
        try {
          outcome = await handle.done;
        } catch (e) {
          return { ok: false, message: 'pnpm 启动失败: ' + String((e && e.message) || e) };
        }
        const out = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : '';
        const err = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : '';
        if (outcome.exitCode !== 0) {
          return { ok: false, message: '更新失败（退出码 ' + String(outcome.exitCode) + '）：' + String(err || out).slice(-400) };
        }
        cache = null;
        return { ok: true, message: '已将 ' + name + ' 更新到最新 commit（重启 DSH 后完全生效）' };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    });

    const tool = harness.defineTool({
      name: 'dsh_check_updates',
      description: '检查本机安装的 DSH / @deepseek-ai 各包（npm 源）及 GitHub 源包相对仓库的更新情况。npm 部分返回每个包的本机版本(local)、稳定版标签(latest)、预发布标签(next)、已发布最高版本(maxPublished)、是否有更新(hasUpdate)；GitHub 部分返回仓库(repo)、已安装 commit(installedCommit)、远程默认分支最新 commit(latestCommit)、是否有更新(hasUpdate)。附 DSH 发行版号(dshRelease)与汇总(summary / githubSummary)。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderReport(value) }],
      },
      async execute() {
        return await runCheck(true);
      },
    });
    harness.registerTool(ctx, tool);
  },
};
}
