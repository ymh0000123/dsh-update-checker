// Standalone validation script for the DSH update-check logic (npm + GitHub sources).
// It is embedded (String.raw) in the dynamic plugin; this copy exists only
// for offline verification. Run: node check-dsh-updates.cjs
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

function gitRun(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { encoding: 'utf8', timeout: timeoutMs || 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ error: String((stderr && stderr.trim()) || (err && err.message) || 'git failed') });
      else resolve({ output: String(stdout || '').trim() });
    });
  });
}

async function githubApiLatest(repo) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.github.com/repos/' + repo + '/commits?per_page=1', {
        headers: { 'User-Agent': 'dsh-update-checker', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const arr = await res.json();
        if (Array.isArray(arr) && arr.length > 0 && arr[0].sha) return { latest: arr[0].sha };
        return { error: 'GitHub API 响应异常' };
      }
      lastErr = 'GitHub API HTTP ' + res.status;
      if (res.status === 403 || res.status === 429) return { error: lastErr + '（限流）' };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { error: lastErr || 'GitHub API 请求失败' };
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
  return {
    name: dep.name,
    kind: 'link-git',
    repo,
    installedCommit: head.output.trim(),
    local,
  };
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
    let latest = null;
    let via = null;
    let gitErr = null;
    const r = await gitRun(['ls-remote', 'https://github.com/' + p.repo + '.git', 'HEAD'], 8000);
    if (r.error) {
      gitErr = r.error;
    } else {
      const candidate = (r.output.split(/\s+/)[0] || '').trim();
      if (candidate) { latest = candidate; via = 'git'; }
      else gitErr = 'git ls-remote 无输出';
    }
    if (!latest) {
      const api = await githubApiLatest(p.repo);
      if (api.latest) { latest = api.latest; via = 'api'; gitErr = null; }
      else if (api.error) gitErr = (gitErr ? gitErr + '；' : '') + api.error;
    }
    done++;
    if (!latest) {
      emitProgress('github', done, total, p.repo + '（失败）');
      return Object.assign({}, p, { hasUpdate: false, latestCommit: null, error: gitErr || '无法获取最新 commit' });
    }
    emitProgress('github', done, total, p.repo + (via === 'api' ? '（API）' : ''));
    return Object.assign({}, p, { latestCommit: latest, hasUpdate: latest !== p.installedCommit, via });
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

  // GitHub-sourced packages
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

  process.stdout.write(JSON.stringify({
    ok: true,
    home,
    profilePath: profileDir,
    dshRelease,
    checkedAt: new Date().toISOString(),
    summary,
    packages,
    github,
    githubSummary,
  }));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e), home }));
});
