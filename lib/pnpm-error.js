'use strict';
/**
 * Turn a failed `pnpm update` run into one sentence a user can act on.
 *
 * pnpm writes success chatter ("✓ Lockfile passes supply-chain policies",
 * "Progress: resolved 30…") to the same streams as its failures, and its real
 * error line is tagged `[ERROR]` or `ERR_PNPM_*` — so naive "first line" or
 * /^ERROR/ extraction reports a success line as the cause. Everything here is
 * about not doing that.
 */

/** Lines pnpm prints while succeeding, plus stack frames. Never the cause. */
const NOISE = [
  /^✓/,
  /^Progress:/,
  /^Packages:\s/,
  /^Progress\b/,
  /^\[WARN\]/,
  /^\[INFO\]/,
  /^Already up to date/,
  /^Lockfile is up to date/,
  /^Done in\b/,
  /^dependencies:/,
  /^devDependencies:/,
  /^[+-]\s/,
  /^at\s/,
  /^-{3,}$/,
  /^This error happened while/,
  /^Add the package to/,
  /^For example:/,
  /^allowBuilds:/,
];

/** Markers that identify the real cause, most specific first. */
const CAUSE = [
  /^ERR_PNPM_[A-Z0-9_]+/,
  /^\[ERR_PNPM_[A-Z0-9_]+\]/,
  /^\[ERROR\]/,
  /^ERROR\b/,
  /^error\b/,
  /^fatal:/,
  /^pnpm:\s/,
  /^Error:/,
];

function lines(text) {
  if (!text) return [];
  return String(text)
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0);
}

function isNoise(line) {
  for (const re of NOISE) if (re.test(line)) return true;
  return false;
}

/** The first line that looks like a cause, else the first non-noise line. */
function firstCause(text) {
  const all = lines(text).filter((l) => !isNoise(l));
  for (const re of CAUSE) {
    const hit = all.find((l) => re.test(l));
    if (hit !== undefined) return hit;
  }
  return all.length > 0 ? all[0] : '';
}

/** `[ERR_PNPM_X] msg` / `[ERROR] msg` -> `msg`, so the sentence reads plainly. */
function stripTag(line) {
  return String(line || '')
    .replace(/^\[?(ERR_PNPM_[A-Z0-9_]+|ERROR|error)\]?[:\s]*/, '')
    .replace(/^pnpm:\s*/, '')
    .trim();
}

function clip(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Classify a failed pnpm run.
 * @param {{stdout?: string, stderr?: string, code?: number|null, name?: string}} run
 * @returns {{kind: string, message: string, detail: string}}
 */
function classifyPnpmFailure(run) {
  const stdout = (run && run.stdout) || '';
  const stderr = (run && run.stderr) || '';
  const code = run && run.code !== undefined ? run.code : null;
  const name = (run && run.name) || '该包';
  const all = stdout + '\n' + stderr;
  const cause = firstCause(stderr) || firstCause(stdout);
  const detail = clip(stripTag(cause), 240);

  // 1. The profile's supply-chain policy blocked a build script for this commit.
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|not in the "allowBuilds" allowlist/.test(all)) {
    const suggested = /allowBuilds:\s*[\r\n]+\s*([^\r\n]+?):\s*true/.exec(all);
    const key = suggested ? suggested[1].trim() : null;
    return {
      kind: 'allow-builds',
      detail,
      message:
        name + ' 需要执行构建脚本（prepare），而新 commit 不在 profile 的 allowBuilds 白名单里——这是 DSH 供应链策略主动拦截，不是网络问题。'
        + '要更新需先在 pnpm-workspace.yaml 的 allowBuilds 下加一行：'
        + (key ? '\n  ' + key + ': true' : '\n  ' + name + '@<新 tarball URL>: true'),
    };
  }

  // 2. git to github.com is unreachable — the common case on blocked networks.
  if (/Recv failure|Connection was reset|Failed to connect to github\.com|Could not resolve host|unable to access '(?:https|git)/.test(all)
    || /exit code 128/.test(all)) {
    const reason = /(Recv failure[^\r\n]*|Connection was reset[^\r\n]*|Failed to connect to github\.com[^\r\n]*|Could not resolve host[^\r\n]*)/.exec(all);
    return {
      kind: 'github-git-unreachable',
      detail,
      message:
        'github.com 的 git 通道不可达（' + clip(reason ? reason[1] : detail, 120) + '）。'
        + '检测本身走 GitHub API 所以正常，但 pnpm 更新必须直连 github.com 拉取 commit；网络恢复后重试即可。',
    };
  }

  // 3. The release-age policy is holding the new version back.
  if (/minimumReleaseAge|ERR_PNPM_.*RELEASE_AGE/i.test(all)) {
    return {
      kind: 'release-age',
      detail,
      message: name + ' 的新版本还没过 profile 的 minimumReleaseAge 冷静期，要么等待，要么把该版本加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude。',
    };
  }

  // 4. Registry/network auth problems.
  if (/ERR_PNPM_FETCH_40[13]|ERR_PNPM_REGISTRY|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(all)) {
    return {
      kind: 'network',
      detail,
      message: '拉取依赖时网络失败：' + (detail || '连接被中断') + '。稍后重试。',
    };
  }

  // 5. The lockfile is out of sync with the manifest.
  if (/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/.test(all)) {
    return {
      kind: 'lockfile',
      detail,
      message: 'lockfile 与 package.json 不一致：' + (detail || '需要重新安装') + '。可在 profile 目录执行一次 pnpm install 修复。',
    };
  }

  return {
    kind: 'unknown',
    detail,
    message: '更新失败' + (code === null ? '' : '（退出码 ' + code + '）') + '：' + (detail || '未知错误'),
  };
}

module.exports = { classifyPnpmFailure, firstCause, stripTag };
