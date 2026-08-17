'use strict';
/**
 * Edit the profile's pnpm supply-chain allowlist — deliberately, one commit at
 * a time.
 *
 * A github-sourced package that ships no build output (dsh-better-sidebar keeps
 * `lib/` out of the repo and builds it with `prepare: tsdown`) can only be
 * installed if pnpm is allowed to run that build script. DSH gates this with
 * `allowBuilds` in pnpm-workspace.yaml, keyed by the EXACT resolved tarball, so
 * a new commit is never implicitly trusted just because the previous one was.
 *
 * This module never grants anything on its own: `planAuthorization` returns the
 * precise line that would be written so a human can read it first, and
 * `authorizeBuild` writes only that line. Granting a new commit REPLACES the
 * package's stale entry instead of piling up, so the allowlist keeps saying
 * exactly which commit is trusted.
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

/** Index of the first line after the allowBuilds block (exclusive end). */
function blockEnd(lines, headerIdx) {
  let end = headerIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') { end++; continue; }
    if (/^[ \t]/.test(line)) { end++; continue; }
    break;
  }
  // Trailing blank lines belong after the block, not inside it.
  while (end > headerIdx + 1 && lines[end - 1].trim() === '') end--;
  return end;
}

/**
 * Match one allowBuilds entry for a package, whatever its value.
 *
 * pnpm does not only write `true`: when it wants the user to decide it rewrites
 * the entry to `set this to true or false`, and it can also write `false`. An
 * entry matcher that only accepts `: true` would leave such a line behind and
 * append a duplicate, so the package would end up both granted and pending.
 * The URL is anchored through `/tar.gz/<sha>` because the value separator must
 * not be confused with the colon inside `https://`.
 */
function entryPattern(subject, anySha) {
  const url = anySha
    ? 'https://codeload\\.github\\.com/[^\\s\'"]+/tar\\.gz/[0-9a-f]{7,40}'
    : null;
  const head = anySha
    ? escapeRe(subject) + '@' + url
    : escapeRe(subject);
  return new RegExp('^[ \\t]*[\'"]?' + head + '[\'"]?[ \\t]*:[ \\t]*(.*)$');
}

const isGranted = (value) => String(value || '').trim() === 'true';

/**
 * Describe what granting this commit would change, without changing anything.
 * @returns {{ok: boolean, error?: string, file: string, key: string, tarball: string,
 *   alreadyAllowed: boolean, replaces: string[], hasSection: boolean}}
 */
function planAuthorization(options) {
  const profileDir = options.profileDir;
  const name = options.name;
  const repo = options.repo;
  const sha = options.sha;
  const file = workspaceFile(profileDir);
  const key = allowKey(name, repo, sha);
  const tarball = tarballUrl(repo, sha);
  const base = { file, key, tarball, alreadyAllowed: false, replaces: [], hasSection: false };

  if (!repo || !sha) return Object.assign({ ok: false, error: '缺少仓库或 commit 信息' }, base);
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
  const exact = entryPattern(key, false);
  const samePackage = entryPattern(name, true);
  const replaces = [];
  let alreadyAllowed = false;
  for (let i = headerIdx + 1; i < end; i++) {
    const line = lines[i];
    const exactHit = exact.exec(line);
    if (exactHit !== null) {
      if (isGranted(exactHit[1])) alreadyAllowed = true;
      else replaces.push(line.trim());
      continue;
    }
    if (samePackage.test(line)) replaces.push(line.trim());
  }
  return Object.assign({ ok: true }, base, { alreadyAllowed, replaces, hasSection: true });
}

/**
 * Grant exactly one commit the right to run its build scripts.
 * @returns {{ok: boolean, error?: string, changed: boolean, file: string, key: string,
 *   tarball: string, added: string|null, replaced: string[]}}
 */
function authorizeBuild(options) {
  const plan = planAuthorization(options);
  if (!plan.ok) return { ok: false, error: plan.error, changed: false, file: plan.file, key: plan.key, tarball: plan.tarball, added: null, replaced: [] };

  const entry = plan.key + ': true';
  const result = { ok: true, changed: false, file: plan.file, key: plan.key, tarball: plan.tarball, added: null, replaced: plan.replaces };

  if (plan.alreadyAllowed && plan.replaces.length === 0) return result;

  let text;
  try {
    text = fs.readFileSync(plan.file, 'utf8');
  } catch (e) {
    return { ok: false, error: '无法读取 pnpm-workspace.yaml: ' + String((e && e.message) || e), changed: false, file: plan.file, key: plan.key, tarball: plan.tarball, added: null, replaced: [] };
  }

  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailing) lines.pop();

  const headerIdx = lines.findIndex((l) => HEADER.test(l));
  const exact = entryPattern(plan.key, false);
  const samePackage = entryPattern(options.name, true);

  let next;
  if (headerIdx < 0) {
    next = lines.slice();
    if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
    next.push('allowBuilds:');
    next.push('  ' + entry);
  } else {
    const end = blockEnd(lines, headerIdx);
    const indentSource = lines.slice(headerIdx + 1, end).find((l) => /^[ \t]+\S/.test(l));
    const indent = indentSource ? (/^([ \t]+)/.exec(indentSource) || ['', '  '])[1] : '  ';
    const kept = [];
    let wroteInPlace = false;
    for (let i = headerIdx + 1; i < end; i++) {
      const line = lines[i];
      if (exact.test(line)) {
        if (wroteInPlace) continue;
        kept.push(indent + entry);
        wroteInPlace = true;
        continue;
      }
      if (samePackage.test(line)) {
        if (wroteInPlace) continue;
        kept.push(indent + entry);
        wroteInPlace = true;
        continue;
      }
      kept.push(line);
    }
    if (!wroteInPlace) kept.push(indent + entry);
    next = lines.slice(0, headerIdx + 1).concat(kept, lines.slice(end));
  }

  const output = next.join(eol) + (trailing ? eol : '');
  if (output === text) return result;

  // Keep one rollback copy, then swap atomically so a crash cannot truncate the
  // profile's policy file.
  const tmp = plan.file + '.dsh-update-checker.tmp';
  try {
    fs.copyFileSync(plan.file, plan.file + '.bak');
    fs.writeFileSync(tmp, output, 'utf8');
    fs.renameSync(tmp, plan.file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* nothing to clean */ }
    return { ok: false, error: '写入 pnpm-workspace.yaml 失败: ' + String((e && e.message) || e), changed: false, file: plan.file, key: plan.key, tarball: plan.tarball, added: null, replaced: [] };
  }

  result.changed = true;
  result.added = entry;
  return result;
}

module.exports = { planAuthorization, authorizeBuild, allowKey, tarballUrl, workspaceFile };
