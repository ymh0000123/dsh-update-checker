'use strict';
/**
 * Portability tests: what happens on SOMEONE ELSE'S machine.
 *
 * Every check here failed (or would have misfired) at some point:
 * - the profile was located by scanning ~/.dsh/profiles and ignoring DSH_HOME,
 *   so a user with a relocated DSH home would have been reported on — and
 *   updated — in the wrong profile;
 * - an installed copy should identify its own profile from its own path instead
 *   of guessing at all;
 * - `pnpm` missing must read as "pnpm missing", not as a package problem.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findProfile, owningProfile, profileRoots } = require('../lib/check.js');
const { classifyPnpmFailure } = require('../lib/pnpm-error.js');

/** A directory that looks like a real dsh profile. */
function makeProfile(root, name, opts) {
  const dir = path.join(root, 'profiles', name);
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name }), 'utf8');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
  if (opts && opts.web) {
    const app = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app' }), 'utf8');
  }
  return dir;
}

test('DSH_HOME is honoured when locating the profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
  const web = makeProfile(home, 'web', { web: true });
  makeProfile(home, 'tui', { web: false });

  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.ok(profileRoots()[0].startsWith(home), 'DSH_HOME must be the first root: ' + profileRoots()[0]);
    assert.equal(findProfile(), web, 'a relocated DSH home must win over ~/.dsh');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the web profile is preferred over other profiles under the same root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home2-'));
  makeProfile(home, 'aaa-headless', { web: false });
  const web = makeProfile(home, 'zzz-web', { web: true });

  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(findProfile(), web, 'alphabetical order must not beat "has the web app"');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an installed copy identifies its own profile from its own path', () => {
  // <profile>/node_modules/dsh-update-checker/lib  (hoisted layout)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-own-'));
  const profile = path.join(root, 'web');
  const pkgLib = path.join(profile, 'node_modules', 'dsh-update-checker', 'lib');
  fs.mkdirSync(pkgLib, { recursive: true });
  fs.mkdirSync(path.join(profile, 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
  assert.equal(owningProfile(pkgLib), profile);

  // <profile>/node_modules/.pnpm/<pkg>@x/node_modules/<pkg>/lib  (isolated layout)
  const isolated = path.join(profile, 'node_modules', '.pnpm', 'dsh-update-checker@1.0.0', 'node_modules', 'dsh-update-checker', 'lib');
  fs.mkdirSync(isolated, { recursive: true });
  assert.equal(owningProfile(isolated), profile, 'the pnpm store folder is not a profile');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a linked checkout outside any profile owns nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-link-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  assert.equal(owningProfile(path.join(dir, 'lib')), null, 'a link: checkout must fall back to the roots scan');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing pnpm is reported as a missing pnpm', () => {
  const win = classifyPnpmFailure({
    stdout: '',
    stderr: "'pnpm' is not recognized as an internal or external command,\noperable program or batch file.\n",
    code: 1,
    name: 'dsh-better-sidebar',
  });
  assert.equal(win.kind, 'pnpm-missing');
  assert.ok(win.message.includes('pnpm'), win.message);

  const posix = classifyPnpmFailure({ stdout: '', stderr: 'sh: 1: pnpm: command not found\n', code: 127, name: 'x' });
  assert.equal(posix.kind, 'pnpm-missing');
});

test('no shipped file carries a developer-machine path', () => {
  const root = path.join(__dirname, '..');
  const shipped = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md']
    .concat(fs.readdirSync(path.join(root, 'lib')).map((f) => path.join('lib', f)));
  const offenders = [];
  for (const rel of shipped) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    // A Windows drive-letter path or a concrete user home is machine-specific.
    for (const m of text.match(/[A-Za-z]:[\\/](?:dsh|Users)[^\s'"`)]*/g) || []) offenders.push(rel + ': ' + m);
    for (const m of text.match(/\/Users\/[a-z0-9._-]+/gi) || []) offenders.push(rel + ': ' + m);
    for (const m of text.match(/\/home\/[a-z0-9._-]+/gi) || []) offenders.push(rel + ': ' + m);
  }
  assert.deepEqual(offenders, [], 'shipped files must not hardcode a machine path');
});
