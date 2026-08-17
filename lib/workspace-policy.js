'use strict';
/**
 * Edit the profile's pnpm supply-chain allowlist — deliberately, one commit at a
 * time, and never in a way that can strand a working install.
 *
 * A github-sourced package that ships no build output (dsh-better-sidebar keeps
 * `lib/` out of the repo; dshmarket builds with tsc) can only be installed if
 * pnpm may run its build script. DSH gates that with `allowBuilds` in
 * pnpm-workspace.yaml, keyed by the EXACT resolved tarball, so a new commit is
 * never implicitly trusted because the previous one was.
 *
 * Three rules this module exists to enforce:
 *
 * 1. Plan before writing. `planAuthorization` returns the precise line, what it
 *    would replace, and what would be pruned afterwards, and touches nothing.
 * 2. Grant only the exact key. `authorizeBuild` never removes another commit's
 *    grant, because the currently INSTALLED commit still needs its own grant
 *    until the new install actually succeeds — pruning first means a failed
 *    update leaves the working package unable to rebuild.
 * 3. Prune only after success, and revert on failure: `pruneOtherGrants` and
 *    `revertGrant`.
 *
 * A value counts as a grant only when it is literally `true`. pnpm also writes
 * `false` and the placeholder `set this to true or false` (it adds that itself
 * for a build it skipped); treating those as absent would append a duplicate and
 * leave the package both granted and pending.
 */
const fs = require('node:fs');
const path = require('node:path');

const HEADER = /^allowBuilds:[ \t]*$/;

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The codeload tarball pnpm resolves a github dependency to. */
function tarballUrl(repo, sha) {
  return 'https://codeload.github.com/' + repo + '/tar.gz/' + sha;
}

/** The allowBuilds key pnpm asks for, in pnpm's own unquoted form. */
function allowKey(name, repo, sha) {
  return name + '@' + tarballUrl(repo, sha);
}

function workspaceFile(profileDir) {
  return path.join(profileDir, 'pnpm-workspace.yaml');
}

const isGranted = (value) => String(value === undefined || value === null ? '' : value).trim() === 'true';

/**
 * One allowBuilds entry for a package at any commit, with any value.
 * The URL is anchored through `/tar.gz/<sha>` so the value separator is never
 * confused with the colon inside `https://`.
 */
function packagePattern(name) {
  return new RegExp(
    '^[ \\t]*[\'"]?' + escapeRe(name)
    + '@https://codeload\\.github\\.com/([^\\s\'"]+)/tar\\.gz/([0-9a-f]{7,40})[\'"]?[ \\t]*:[ \\t]*(.*)$',
  );
}

/** One allowBuilds entry for one exact key. */
function keyPattern(key) {
  return new RegExp('^[ \\t]*[\'"]?' + escapeRe(key) + '[\'"]?[ \\t]*:[ \\t]*(.*)$');
}

/** Index of the first line after the allowBuilds block (exclusive end). */
function blockEnd(lines, headerIdx) {
  let end = headerIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') { end++; continue; }
    if (/^[ \t]/.test(line)) { end++; continue; }
    break;
  }
  while (end > headerIdx + 1 && lines[end - 1].trim() === '') end--;
  return end;
}

/**
 * Rewrite the policy file through a callback, atomically and only if it changed.
 * The callback receives the allowBuilds block and returns its replacement.
 */
function editAllowBuilds(file, mutate) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailing) lines.pop();

  const headerIdx = lines.findIndex((l) => HEADER.test(l));
  let next;
  if (headerIdx < 0) {
    const created = mutate([], '  ');
    if (created === null) return { changed: false };
    next = lines.slice();
    if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
    next.push('allowBuilds:');
    next = next.concat(created);
  } else {
    const end = blockEnd(lines, headerIdx);
    const block = lines.slice(headerIdx + 1, end);
    const indentSource = block.find((l) => /^[ \t]+\S/.test(l));
    const indent = indentSource ? (/^([ \t]+)/.exec(indentSource) || ['', '  '])[1] : '  ';
    const replacement = mutate(block, indent);
    if (replacement === null) return { changed: false };
    next = lines.slice(0, headerIdx + 1).concat(replacement, lines.slice(end));
  }

  const output = next.join(eol) + (trailing ? eol : '');
  if (output === text) return { changed: false };

  const tmp = file + '.dsh-update-checker.tmp';
  try {
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(tmp, output, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* nothing to clean */ }
    throw e;
  }
  return { changed: true };
}

/**
 * Describe what granting this commit would change, without changing anything.
 * @returns {{ok: boolean, error?: string, file: string, key: string, tarball: string,
 *   alreadyAllowed: boolean, replaces: string[], prunesAfterSuccess: string[], hasSection: boolean}}
 */
function planAuthorization(options) {
  const file = workspaceFile(options.profileDir);
  const key = allowKey(options.name, options.repo, options.sha);
  const base = {
    file,
    key,
    tarball: tarballUrl(options.repo, options.sha),
    alreadyAllowed: false,
    replaces: [],
    prunesAfterSuccess: [],
    hasSection: false,
  };

  if (!options.repo || !options.sha) return Object.assign({ ok: false, error: '缺少仓库或 commit 信息' }, base);
  if (!fs.existsSync(file)) return Object.assign({ ok: false, error: 'pnpm-workspace.yaml 不存在: ' + file }, base);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return Object.assign({ ok: false, error: '无法读取 pnpm-workspace.yaml: ' + String((e && e.message) || e) }, base);
  }

  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => HEADER.test(l));
  if (headerIdx < 0) return Object.assign({ ok: true }, base);

  const end = blockEnd(lines, headerIdx);
  const exact = keyPattern(key);
  const anyCommit = packagePattern(options.name);
  const replaces = [];
  const prunes = [];
  let alreadyAllowed = false;
  for (let i = headerIdx + 1; i < end; i++) {
    const line = lines[i];
    const exactHit = exact.exec(line);
    if (exactHit !== null) {
      if (isGranted(exactHit[1])) alreadyAllowed = true;
      else replaces.push(line.trim());
      continue;
    }
    if (anyCommit.test(line)) prunes.push(line.trim());
  }
  return Object.assign({ ok: true }, base, {
    alreadyAllowed,
    replaces,
    prunesAfterSuccess: prunes,
    hasSection: true,
  });
}

/**
 * Grant exactly one commit the right to run its build scripts.
 *
 * Other commits' grants are deliberately left alone: the installed one still
 * needs its grant while this install is only being attempted.
 * @returns {{ok: boolean, error?: string, changed: boolean, file: string, key: string,
 *   tarball: string, added: string|null, previous: {existed: boolean, line: string|null}}}
 */
function authorizeBuild(options) {
  const plan = planAuthorization(options);
  const result = {
    ok: true,
    changed: false,
    file: plan.file,
    key: plan.key,
    tarball: plan.tarball,
    added: null,
    previous: { existed: false, line: null },
  };
  if (!plan.ok) return Object.assign(result, { ok: false, error: plan.error });

  const entry = plan.key + ': true';
  const exact = keyPattern(plan.key);
  try {
    const outcome = editAllowBuilds(plan.file, (block, indent) => {
      const kept = [];
      let wrote = false;
      for (const line of block) {
        if (exact.test(line)) {
          result.previous = { existed: true, line: line };
          if (wrote) continue;
          kept.push(indent + entry);
          wrote = true;
          continue;
        }
        kept.push(line);
      }
      if (!wrote) kept.push(indent + entry);
      return kept;
    });
    result.changed = outcome.changed;
    if (outcome.changed) result.added = entry;
  } catch (e) {
    return Object.assign(result, { ok: false, error: '写入 pnpm-workspace.yaml 失败: ' + String((e && e.message) || e) });
  }
  return result;
}

/**
 * After a successful install, drop the package's grants for every other commit:
 * they are not installed any more, so keeping them silently widens trust.
 */
function pruneOtherGrants(options) {
  const file = workspaceFile(options.profileDir);
  const result = { ok: true, changed: false, file, removed: [] };
  if (!fs.existsSync(file)) return Object.assign(result, { ok: false, error: 'pnpm-workspace.yaml 不存在: ' + file });
  const anyCommit = packagePattern(options.name);
  try {
    const outcome = editAllowBuilds(file, (block) => {
      const kept = [];
      for (const line of block) {
        const hit = anyCommit.exec(line);
        if (hit !== null && hit[2] !== options.keepSha) {
          result.removed.push(line.trim());
          continue;
        }
        kept.push(line);
      }
      return kept;
    });
    result.changed = outcome.changed;
  } catch (e) {
    return Object.assign(result, { ok: false, error: '写入 pnpm-workspace.yaml 失败: ' + String((e && e.message) || e) });
  }
  return result;
}

/** Undo one authorizeBuild: restore the previous line, or remove what was added. */
function revertGrant(options) {
  const file = workspaceFile(options.profileDir);
  const key = allowKey(options.name, options.repo, options.sha);
  const result = { ok: true, changed: false, file, key };
  if (!fs.existsSync(file)) return Object.assign(result, { ok: false, error: 'pnpm-workspace.yaml 不存在: ' + file });
  const exact = keyPattern(key);
  const previous = options.previous || { existed: false, line: null };
  try {
    const outcome = editAllowBuilds(file, (block) => {
      const kept = [];
      let handled = false;
      for (const line of block) {
        if (exact.test(line)) {
          if (handled) continue;
          handled = true;
          if (previous.existed && previous.line !== null) kept.push(previous.line);
          continue;
        }
        kept.push(line);
      }
      return kept;
    });
    result.changed = outcome.changed;
  } catch (e) {
    return Object.assign(result, { ok: false, error: '写入 pnpm-workspace.yaml 失败: ' + String((e && e.message) || e) });
  }
  return result;
}

module.exports = {
  planAuthorization,
  authorizeBuild,
  pruneOtherGrants,
  revertGrant,
  allowKey,
  tarballUrl,
  workspaceFile,
};
