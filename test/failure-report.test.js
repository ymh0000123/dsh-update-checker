'use strict';
/**
 * Regression tests for the two bugs a real failed update exposed:
 *
 * 1. The error shown to the user was pnpm's SUCCESS line
 *    ("✓ Lockfile passes supply-chain policies") because the extractor looked
 *    for /^ERROR/ and pnpm tags its cause `[ERROR]` / `ERR_PNPM_*`.
 * 2. A package already at the newest commit was reported as updatable, because
 *    the installed commit was read from the lockfile's `packages:`/`snapshots:`
 *    sections (which can keep a superseded entry) instead of `importers:`.
 *
 * The pnpm outputs below are verbatim captures from this machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyPnpmFailure } = require('../lib/pnpm-error.js');
const { parseGithubFromLockfile, githubFromResolution, cmp, maxOf } = require('../lib/check.js');

const LS_REMOTE_BLOCKED = [
  '✓ Lockfile passes supply-chain policies (verified 7m ago)',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  'Progress: resolved 30, reused 3, downloaded 0, added 0',
  '[ERROR] Command failed with exit code 128: git ls-remote "git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git" HEAD "HEAD^{}"',
  '',
  "fatal: unable to access 'https://github.com/omdsh-dev/DSH-better-sidebar.git/': Recv failure: Connection was reset",
  '',
  'This error happened while installing a direct dependency of C:\\Users\\ad\\.dsh\\profiles\\web',
  '    at getFinalError (file:///C:/Users/ad/.pnpm/.tools/pnpm/11.6.0/node_modules/pnpm/dist/pnpm.mjs:34053:14)',
].join('\n');

const ALLOW_BUILDS_BLOCKED = [
  '✓ Lockfile passes supply-chain policies (verified 15m ago)',
  'Progress: resolved 30, reused 3, downloaded 0, added 0',
  '[WARN] Tarball download average speed 49 KiB/s (size 482 KiB) is below 50 KiB/s: https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/c923fc57 (GET)',
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/c923fc57b1a64b898d8b6d1bcc76cfb941831255": The git-hosted package "dsh-better-sidebar@0.12.3" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  dsh-better-sidebar@https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/c923fc57b1a64b898d8b6d1bcc76cfb941831255: true',
].join('\n');

test('never reports a pnpm success line as the failure cause', () => {
  const r = classifyPnpmFailure({ stdout: LS_REMOTE_BLOCKED, stderr: '', code: 1, name: 'dsh-better-sidebar' });
  assert.ok(!r.message.includes('Lockfile passes'), 'success chatter leaked: ' + r.message);
  assert.ok(!r.message.includes('Progress:'), 'progress line leaked: ' + r.message);
});

test('classifies a blocked github.com git channel', () => {
  const r = classifyPnpmFailure({ stdout: LS_REMOTE_BLOCKED, stderr: '', code: 1, name: 'dsh-better-sidebar' });
  assert.equal(r.kind, 'github-git-unreachable');
  assert.ok(r.message.includes('github.com'), r.message);
  assert.ok(/Recv failure|Connection was reset/.test(r.message), r.message);
  assert.ok(r.message.includes('网络恢复后重试'), r.message);
});

test('classifies the allowBuilds supply-chain block and quotes the exact key', () => {
  const r = classifyPnpmFailure({ stdout: ALLOW_BUILDS_BLOCKED, stderr: '', code: 1, name: 'dsh-better-sidebar' });
  assert.equal(r.kind, 'allow-builds');
  assert.ok(r.message.includes('allowBuilds'), r.message);
  assert.ok(
    r.message.includes('dsh-better-sidebar@https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/c923fc57b1a64b898d8b6d1bcc76cfb941831255: true'),
    'the ready-to-paste allowlist key is missing: ' + r.message,
  );
  assert.ok(r.message.includes('不是网络问题'), 'a policy block must say it is not a network fault: ' + r.message);
  assert.ok(!r.message.includes('网络恢复后重试'), 'a policy block must not tell the user to wait for the network: ' + r.message);
});

test('classifies a skipped build script (allowlist entry not true)', () => {
  // pnpm prints this inside a box-drawing warning frame and still exits 1.
  const IGNORED = [
    '✓ Lockfile passes supply-chain policies (verified 2m ago)',
    'Progress: resolved 30, reused 3, downloaded 0, added 0',
    '╭ Warning ─────────────────────────────────────────────────────────────────────╮',
    '│                                                                              │',
    '│   Ignored build scripts: dsh-better-sidebar@https://codeload.github.com/omd  │',
    '│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │',
    '│   to run scripts.                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n');
  const r = classifyPnpmFailure({ stdout: IGNORED, stderr: '', code: 1, name: 'dsh-better-sidebar' });
  assert.equal(r.kind, 'ignored-build-scripts');
  assert.ok(r.message.includes('构建脚本被跳过'), r.message);
  assert.ok(r.message.includes('allowBuilds'), r.message);
  assert.ok(!r.message.includes('Lockfile passes'), 'success chatter leaked: ' + r.message);
  assert.ok(r.message.indexOf('╭') < 0 && r.message.indexOf('│') < 0, 'box borders leaked: ' + r.message);
  assert.ok(!r.message.includes('网络恢复后重试'), 'a policy problem must not be blamed on the network: ' + r.message);
});

test('falls back to the first real cause for an unknown failure', () => {
  const r = classifyPnpmFailure({
    stdout: '✓ Lockfile passes supply-chain policies (verified 1m ago)\nProgress: resolved 3\n',
    stderr: 'ERR_PNPM_SOMETHING_ELSE  Everything is on fire\n    at foo (bar.mjs:1:1)\n',
    code: 1,
    name: 'x',
  });
  assert.equal(r.kind, 'unknown');
  assert.ok(r.message.includes('Everything is on fire'), r.message);
  assert.ok(r.message.includes('退出码 1'), r.message);
});

test('reads the installed commit from importers, not a superseded packages entry', () => {
  // A lockfile whose packages/snapshots sections still name an older commit for
  // the same package: the importer entry is the one that is installed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-lock-'));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), [
    'lockfileVersion: \'9.0\'',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    "      '@anionex/dsh-vision-toolkit':",
    '        specifier: github:Anionex/dsh-vision-toolkit',
    '        version: https://codeload.github.com/Anionex/dsh-vision-toolkit/tar.gz/86fcf711a669552ca39ccaad7cf441cc70a7859b(a12cad7fe1ac0c3a1966ce9c1533f949)',
    '      dsh-client-masquerade:',
    '        specifier: github:ymh0000123/dsh-client-masquerade',
    '        version: https://codeload.github.com/ymh0000123/dsh-client-masquerade/tar.gz/2c212f994a7ef1abbe480abf8e844bc07eed7d62(34bbf757af9830d16b41ea404b55d774)',
    '      dsh-theme-endfield:',
    '        specifier: link:E:/dsh/1/dsh-theme-endfield',
    '        version: link:../../../../E:/dsh/1/dsh-theme-endfield',
    '',
    'packages:',
    '',
    '  dsh-client-masquerade@https://codeload.github.com/ymh0000123/dsh-client-masquerade/tar.gz/16338f79aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:',
    '    resolution: {gitHosted: true}',
    '',
  ].join('\n'), 'utf8');

  const deps = parseGithubFromLockfile(dir);
  const byName = new Map(deps.map((d) => [d.name, d]));

  const masq = byName.get('dsh-client-masquerade');
  assert.ok(masq, 'masquerade not found');
  assert.equal(masq.installedCommit, '2c212f994a7ef1abbe480abf8e844bc07eed7d62', 'must be the importer commit, not the stale packages entry');
  assert.equal(masq.repo, 'ymh0000123/dsh-client-masquerade');
  assert.equal(masq.kind, 'github-dep');

  const vision = byName.get('@anionex/dsh-vision-toolkit');
  assert.ok(vision, 'scoped github dep not found');
  assert.equal(vision.installedCommit, '86fcf711a669552ca39ccaad7cf441cc70a7859b');

  assert.equal(byName.has('dsh-theme-endfield'), false, 'link deps are not github deps');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('falls back to the packages scan when there is no importers section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-lock-old-'));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), [
    'lockfileVersion: \'6.0\'',
    '',
    'packages:',
    '',
    '  dsh-anyrouter-1m@https://codeload.github.com/ymh0000123/dsh-anyrouter-1m/tar.gz/11452ecbab35dd0e191770b94ff8eb59e043b929:',
    '    resolution: {gitHosted: true}',
    '',
  ].join('\n'), 'utf8');
  const deps = parseGithubFromLockfile(dir);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].name, 'dsh-anyrouter-1m');
  assert.equal(deps[0].installedCommit, '11452ecbab35dd0e191770b94ff8eb59e043b929');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recognises both github resolution shapes', () => {
  assert.deepEqual(
    githubFromResolution('https://codeload.github.com/o/r/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    { repo: 'o/r', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  );
  assert.deepEqual(
    githubFromResolution('git+ssh://git@github.com/o/r.git#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    { repo: 'o/r', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  );
  assert.equal(githubFromResolution('link:../elsewhere'), null);
  assert.equal(githubFromResolution('0.1.0-rc.6'), null);
});

test('version comparison keeps prereleases below their release', () => {
  assert.equal(cmp('0.1.0', '0.1.0-rc.6') > 0, true);
  assert.equal(cmp('0.1.0-rc.7', '0.1.0-rc.6') > 0, true);
  assert.equal(cmp('0.1.0-rc.6', '0.1.0-rc.6'), 0);
  assert.equal(maxOf(['0.0.1-rc.1', '0.1.0-rc.6', '0.1.0-rc.2']), '0.1.0-rc.6');
});
