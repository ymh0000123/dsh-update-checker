'use strict';
/**
 * dsh-update-checker — shared detection logic (installed HOST half).
 *
 * The dynamic-plugin variant (src/host.js) runs this same logic inside a
 * `node -` subprocess because the dynamic VM has no `require`. The installed
 * half runs in the real host process, so it just requires this module and gets
 * progress through a callback instead of parsing PROGRESS lines off stderr.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const NOOP = () => {};

/** A profile directory has a manifest plus either a lockfile or installed packages. */
function looksLikeProfile(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return false;
  return fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))
    || fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai'));
}

/**
 * The profile this copy is INSTALLED INTO, derived from its own location.
 *
 * This is the only strategy that cannot pick the wrong profile: an installed
 * package lives at `<profile>/node_modules/<name>`, so walking up to the
 * node_modules boundary names its owner exactly — whatever DSH_HOME is set to
 * and however many profiles exist. Boundaries are tried from the innermost out
 * so pnpm's isolated store layout (`node_modules/.pnpm/<pkg>/node_modules/<pkg>`)
 * resolves to the profile rather than to a store folder.
 * Returns null for a `link:`ed checkout, which lives outside any profile.
 */
function owningProfile(fromDir) {
  const parts = String(fromDir || __dirname).split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i] !== 'node_modules') continue;
    const candidate = parts.slice(0, i).join(path.sep);
    if (looksLikeProfile(candidate)) return candidate;
  }
  return null;
}

/** Where profiles live: the documented DSH_HOME override first, then the default. */
function profileRoots() {
  const roots = [];
  const explicit = process.env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') roots.push(path.join(explicit.trim(), 'profiles'));
  roots.push(path.join(os.homedir(), '.dsh', 'profiles'));
  return roots;
}

function scanProfileRoot(profilesRoot) {
  if (!fs.existsSync(profilesRoot)) return null;
  let dirs = [];
  try {
    dirs = fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(profilesRoot, d.name));
  } catch (e) {
    return null;
  }
  const withPackages = dirs.filter((d) => fs.existsSync(path.join(d, 'node_modules', '@deepseek-ai')));
  if (withPackages.length === 0) return null;
  const web = withPackages.filter((d) => fs.existsSync(path.join(d, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')));
  return web.length ? web[0] : withPackages[0];
}

/**
 * Locate the dsh profile to report on: the one that owns this install, else the
 * best candidate under DSH_HOME, else under ~/.dsh.
 */
function findProfile() {
  const owning = owningProfile();
  if (owning !== null) return owning;
  for (const root of profileRoots()) {
    const found = scanProfileRoot(root);
    if (found !== null) return found;
  }
  return null;
}

function readLocalPackages(profileDir) {
  const scoped = path.join(profileDir, 'node_modules', '@deepseek-ai');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(scoped);
  } catch (e) {
    return out;
  }
  for (const name of names) {
    const pj = path.join(scoped, name, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (meta && typeof meta.version === 'string') out.push({ name: '@deepseek-ai/' + name, local: meta.version });
    } catch (e) { /* skip unreadable package */ }
  }
  return out;
}

function readInstalledVersion(profileDir, name) {
  const pj = path.join(profileDir, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pj)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return meta && typeof meta.version === 'string' ? meta.version : undefined;
  } catch (e) {
    return undefined;
  }
}

function gitRun(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { encoding: 'utf8', timeout: timeoutMs || 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ error: String((stderr && stderr.trim()) || (err && err.message) || 'git failed') });
      else resolve({ output: String(stdout || '').trim() });
    });
  });
}

/** github.com:443 is blocked in some networks; api.github.com usually is not. */
async function githubApiLatest(repo) {
  // Unauthenticated api.github.com allows 60 requests/hour per IP, which a few
  // re-checks across a handful of repos exhaust. A token is used when the
  // environment already offers one; nothing is stored or written.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { 'User-Agent': 'dsh-update-checker', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.github.com/repos/' + repo + '/commits?per_page=1', {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const arr = await res.json();
        if (Array.isArray(arr) && arr.length > 0 && arr[0].sha) return { latest: arr[0].sha };
        return { error: 'GitHub API 响应异常' };
      }
      lastErr = 'GitHub API HTTP ' + res.status;
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const limited = res.status === 429 || remaining === '0';
        return {
          error: limited
            ? 'GitHub API 限流' + (token ? '' : '（未认证为每小时 60 次；设置 GITHUB_TOKEN 可提升到 5000 次）')
            : lastErr,
          rateLimited: limited,
        };
      }
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { error: lastErr || 'GitHub API 请求失败' };
}

/** Parse `git ls-remote` output into the branch HEAD plus every tag. */
function parseLsRemote(output) {
  const result = { head: null, tags: [] };
  for (const line of String(output || '').split('\n')) {
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] === 'HEAD') {
      if (result.head === null) result.head = m[1];
      continue;
    }
    // An annotated tag also emits `refs/tags/x^{}` for the commit it points at;
    // that dereferenced line is the one a tarball resolution matches.
    const tag = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(m[2]);
    if (tag) result.tags.push({ name: tag[1], sha: m[1] });
  }
  return result;
}

function githubRepoFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(url.replace(/^git\+/, ''));
  if (!m) return null;
  return m[1] + '/' + m[2].replace(/\.git$/, '');
}

/** Extract owner/repo + commit from a pnpm resolution or dependency spec. */
function githubFromResolution(value) {
  if (typeof value !== 'string') return null;
  let m = /codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})/.exec(value);
  if (m) return { repo: m[1] + '/' + m[2], sha: m[3] };
  m = /github\.com[:/]([^/]+)\/([^/#]+?)(?:\.git)?#([0-9a-f]{40})/.exec(value);
  if (m) return { repo: m[1] + '/' + m[2], sha: m[3] };
  return null;
}

/**
 * Read the github-sourced dependencies and the commit each one is installed at.
 *
 * The authoritative source is the lockfile's `importers:` section: one
 * `specifier` + resolved `version` pair per direct dependency. The `packages:`
 * and `snapshots:` sections are NOT authoritative — they can still carry a
 * superseded entry for the same package after an update, and picking the first
 * match there reports a package as updatable when it is already current.
 * The old scan stays as a fallback for lockfiles with no importers section.
 */
function parseGithubFromLockfile(profileDir) {
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return [];
  let text = '';
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    return [];
  }
  const seen = new Map();
  const add = (name, resolved, specifier) => {
    if (seen.has(name)) return;
    const g = githubFromResolution(resolved) || githubFromResolution(specifier);
    if (!g) return;
    const spec = specifier === undefined ? undefined : String(specifier).trim();
    seen.set(name, {
      name,
      repo: g.repo,
      installedCommit: g.sha,
      kind: 'github-dep',
      specifier: spec,
      // A bare `github:owner/repo` follows the default branch; anything with a
      // ref or an explicit tarball URL was pinned on purpose, so "newer commit
      // on the branch" is information, not a pending upgrade.
      pinned: spec === undefined ? false : (spec.indexOf('#') >= 0 || spec.indexOf('/tar.gz/') >= 0),
      local: readInstalledVersion(profileDir, name),
    });
  };

  const importerRe = /^[ \t]{4,10}'?((?:@[^'\s/]+\/)?[^'\s:]+?)'?:[ \t]*\r?\n[ \t]+specifier:[ \t]*([^\r\n]+)\r?\n[ \t]+version:[ \t]*([^\r\n]+)/gm;
  let m;
  while ((m = importerRe.exec(text)) !== null) add(m[1], m[3], m[2]);
  if (seen.size > 0) return Array.from(seen.values());

  const packagesRe = /^ {2}['"]?((?:@[^/]+\/)?[^@'"\r\n]+)@https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})/gm;
  while ((m = packagesRe.exec(text)) !== null) add(m[1], m[0]);
  return Array.from(seen.values());
}

function findLinkDeps(profileDir) {
  const pjPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pjPath)) return [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  } catch (e) {
    return [];
  }
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
  } catch (e) {
    local = undefined;
  }
  return { name: dep.name, kind: 'link-git', repo, installedCommit: head.output.trim(), local };
}

function parseV(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { core: [m[1] || '0', m[2] || '0', m[3] || '0'].map(Number), pre: m[4] ? m[4].split('.') : null };
}

/** semver-ish compare that keeps prereleases below their release. */
function cmp(a, b) {
  const A = parseV(a);
  const B = parseV(b);
  if (!A || !B) {
    const sa = String(a || '');
    const sb = String(b || '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1;
  }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
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
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10000),
  });
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
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        results[i] = Object.assign({}, items[i], { error: String((e && e.message) || e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return results;
}

async function checkGithub(items, emit) {
  const total = items.length;
  let done = 0;
  return mapLimit(items, 4, async (p) => {
    if (p.error) {
      done++;
      emit('github', done, total, p.name + '（跳过）');
      return Object.assign({}, p, { hasUpdate: false, latestCommit: null });
    }
    let latest = null;
    let via = null;
    let gitErr = null;
    let rateLimited = false;
    let tags = [];
    // One ls-remote yields the branch HEAD and every tag: the tags are what tell
    // us the installed commit is a RELEASE (dshmarket was pinned at the v1.11.1
    // tag, so comparing it to the moving branch HEAD looked like a permanent
    // "update available").
    const r = await gitRun(['ls-remote', 'https://github.com/' + p.repo + '.git', 'HEAD', 'refs/tags/*'], 8000);
    if (r.error) {
      gitErr = r.error;
    } else {
      const refs = parseLsRemote(r.output);
      tags = refs.tags;
      if (refs.head) {
        latest = refs.head;
        via = 'git';
      } else {
        gitErr = 'git ls-remote 无输出';
      }
    }
    if (!latest) {
      const api = await githubApiLatest(p.repo);
      if (api.latest) {
        latest = api.latest;
        via = 'api';
        gitErr = null;
      } else if (api.error) {
        gitErr = (gitErr ? gitErr + '；' : '') + api.error;
        if (api.rateLimited) rateLimited = true;
      }
    }
    done++;
    if (!latest) {
      emit('github', done, total, p.repo + (rateLimited ? '（限流）' : '（失败）'));
      return Object.assign({}, p, {
        hasUpdate: false,
        latestCommit: null,
        rateLimited,
        error: gitErr || '无法获取最新 commit',
      });
    }
    const installedTag = tags.filter((t) => t.sha === p.installedCommit).map((t) => t.name)[0] || null;
    const latestTag = tags.filter((t) => t.sha === latest).map((t) => t.name)[0] || null;
    emit('github', done, total, p.repo + (via === 'api' ? '（API）' : ''));
    return Object.assign({}, p, {
      latestCommit: latest,
      hasUpdate: latest !== p.installedCommit,
      via,
      installedTag,
      latestTag,
    });
  });
}

/**
 * Run one full detection pass.
 * @param {(phase: string, done: number, total: number, message: string) => void} [onProgress]
 * @returns {Promise<object>} the JSON report the settings page and the model tool both render
 */
async function runCheck(onProgress) {
  const emit = typeof onProgress === 'function' ? onProgress : NOOP;
  try {
    const profileDir = findProfile();
    emit('init', 0, 1, profileDir ? '已找到 profile: ' + profileDir : '未找到 profile');

    const localPkgs = profileDir ? readLocalPackages(profileDir) : [];
    const dshVersions = localPkgs.filter((p) => p.name.indexOf('@deepseek-ai/dsh-') === 0).map((p) => p.local);
    const dshRelease = maxOf(dshVersions) || null;
    const checked = localPkgs.slice();
    if (dshRelease) checked.push({ name: '@deepseek-ai/dsh', local: dshRelease, synthetic: true });

    const npmTotal = checked.length;
    emit('npm', 0, npmTotal, '开始查询 npm 仓库（共 ' + npmTotal + ' 个包）');
    let npmDone = 0;
    const packages = await mapLimit(checked, 8, async (p) => {
      const r = await fetchInfo(p);
      npmDone++;
      emit('npm', npmDone, npmTotal, p.name);
      return r;
    });

    const summary = { total: packages.length, updatable: 0, upToDate: 0, preview: 0, failed: 0 };
    for (const p of packages) {
      if (p.error) summary.failed++;
      else if (p.hasUpdate) summary.updatable++;
      else if (p.local === p.latest) summary.upToDate++;
      else summary.preview++;
    }

    let github = [];
    if (profileDir) {
      github = parseGithubFromLockfile(profileDir);
      for (const link of findLinkDeps(profileDir)) github.push(await gitInfoForLink(link));
    }
    emit('github', 0, github.length, '开始检查 GitHub 仓库（共 ' + github.length + ' 个）');
    github = await checkGithub(github, emit);

    const githubSummary = { total: github.length, updatable: 0, upToDate: 0, failed: 0 };
    for (const p of github) {
      if (p.error) githubSummary.failed++;
      else if (p.hasUpdate) githubSummary.updatable++;
      else githubSummary.upToDate++;
    }
    emit('done', 1, 1, '检查完成');

    return {
      ok: true,
      home: os.homedir(),
      profilePath: profileDir,
      dshRelease,
      checkedAt: new Date().toISOString(),
      summary,
      packages,
      github,
      githubSummary,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || e), home: os.homedir() };
  }
}

/** Plain-text report shared by the model tool renderer. */
function renderReport(value) {
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
        lines.push('  - ' + p.name + ' (' + p.repo + '): ' + String(p.installedCommit).slice(0, 8) + ' -> ' + String(p.latestCommit).slice(0, 8) + (p.via === 'api' ? '（经 API）' : ''));
      }
    }
  } else {
    lines.push('GitHub 源包: 无');
  }
  return lines.join('\n');
}

module.exports = {
  runCheck,
  renderReport,
  findProfile,
  owningProfile,
  profileRoots,
  cmp,
  maxOf,
  parseGithubFromLockfile,
  githubFromResolution,
};
