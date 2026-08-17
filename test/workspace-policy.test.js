'use strict';
/**
 * The supply-chain grant is the one thing this plugin writes into the profile,
 * so it gets tested hard: it must plan before writing, write exactly one line,
 * replace a package's stale grant instead of accumulating, stay idempotent, and
 * never disturb the rest of the policy file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planAuthorization, authorizeBuild, pruneOtherGrants, revertGrant, allowKey, tarballUrl } = require('../lib/workspace-policy.js');

const OLD = 'f842fa002994a4a25dd6a6c8795486ccae5c28f7';
const NEW = 'c923fc57b1a64b898d8b6d1bcc76cfb941831255';
const REPO = 'omdsh-dev/DSH-better-sidebar';
const NAME = 'dsh-better-sidebar';

/** A profile whose policy file mirrors the real one on this machine. */
function makeProfile(allowBuildsBlock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-ws-'));
  const body = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'minimumReleaseAgeExclude:',
    "  - '@deepseek-ai/dsh-base@0.1.0-rc.6'",
  ];
  if (allowBuildsBlock !== null) body.push.apply(body, allowBuildsBlock);
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), body.join('\n') + '\n', 'utf8');
  return dir;
}

const FULL_BLOCK = [
  'allowBuilds:',
  "  '@deepseek-ai/dsh-subprocess-local': true",
  '  koffi: true',
  '  node-pty: true',
  '  ' + NAME + '@' + tarballUrl(REPO, OLD) + ': true',
  '  protobufjs: true',
];

const read = (dir) => fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('planning reports the exact line and changes nothing', () => {
  const dir = makeProfile(FULL_BLOCK);
  const before = read(dir);
  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(plan.ok, true);
  assert.equal(plan.key, NAME + '@https://codeload.github.com/' + REPO + '/tar.gz/' + NEW);
  assert.equal(plan.alreadyAllowed, false);
  assert.deepEqual(plan.replaces, [], 'nothing exists for THIS commit yet');
  assert.deepEqual(plan.prunesAfterSuccess, [NAME + '@' + tarballUrl(REPO, OLD) + ': true'],
    'the installed commit grant is pruned only after a successful install');
  assert.equal(read(dir), before, 'planning must not touch the file');
  cleanup(dir);
});

test('granting adds only this commit and KEEPS the installed commit grant', () => {
  // The installed commit must stay grantable while the new install is merely
  // being attempted: pruning first means a failed update leaves the working
  // package unable to rebuild.
  const dir = makeProfile(FULL_BLOCK);
  const result = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.added, allowKey(NAME, REPO, NEW) + ': true');
  assert.equal(result.previous.existed, false);

  const text = read(dir);
  const lines = text.split('\n');
  assert.ok(text.includes('  ' + allowKey(NAME, REPO, NEW) + ': true'), 'new grant missing');
  assert.ok(text.includes('  ' + allowKey(NAME, REPO, OLD) + ': true'), 'installed grant must survive');
  assert.equal(lines.filter((l) => l.includes(NAME + '@')).length, 2, 'both commits granted during the attempt');

  // The rest of the policy file is untouched.
  assert.ok(text.includes('nodeLinker: hoisted'));
  assert.ok(text.includes('autoInstallPeers: false'));
  assert.ok(text.includes("  - '@deepseek-ai/dsh-base@0.1.0-rc.6'"));
  assert.ok(text.includes("  '@deepseek-ai/dsh-subprocess-local': true"));
  assert.ok(text.includes('  koffi: true'));
  assert.ok(text.includes('  node-pty: true'));
  assert.ok(text.includes('  protobufjs: true'));
  assert.equal(lines.length, FULL_BLOCK.length + 9, 'exactly one line added');

  // A rollback copy exists.
  assert.ok(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml.bak')));
  assert.ok(read(dir) !== fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml.bak'), 'utf8'));
  cleanup(dir);
});

test('pruning after success drops the other commits and keeps the installed one', () => {
  const dir = makeProfile(FULL_BLOCK);
  authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  const prune = pruneOtherGrants({ profileDir: dir, name: NAME, keepSha: NEW });
  assert.equal(prune.ok, true);
  assert.equal(prune.changed, true);
  assert.deepEqual(prune.removed, [allowKey(NAME, REPO, OLD) + ': true']);

  const lines = read(dir).split('\n').filter((l) => l.includes(NAME + '@'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trim(), allowKey(NAME, REPO, NEW) + ': true');
  assert.ok(read(dir).includes('  koffi: true'), 'other packages untouched');

  const again = pruneOtherGrants({ profileDir: dir, name: NAME, keepSha: NEW });
  assert.equal(again.changed, false, 'pruning twice is a no-op');
  cleanup(dir);
});

test('reverting a failed attempt restores the file exactly', () => {
  const dir = makeProfile(FULL_BLOCK);
  const before = read(dir);
  const grant = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(grant.changed, true);
  const revert = revertGrant({ profileDir: dir, name: NAME, repo: REPO, sha: NEW, previous: grant.previous });
  assert.equal(revert.ok, true);
  assert.equal(read(dir), before, 'a failed authorized update must leave no trace');
  cleanup(dir);
});

test('reverting restores a placeholder pnpm had written itself', () => {
  const placeholder = '  ' + allowKey(NAME, REPO, NEW) + ': set this to true or false';
  const dir = makeProfile(['allowBuilds:', '  koffi: true', placeholder]);
  const before = read(dir);
  const grant = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(grant.changed, true);
  assert.equal(grant.previous.existed, true);
  assert.ok(read(dir).includes('  ' + allowKey(NAME, REPO, NEW) + ': true'));
  revertGrant({ profileDir: dir, name: NAME, repo: REPO, sha: NEW, previous: grant.previous });
  assert.equal(read(dir), before, 'the placeholder must come back verbatim');
  cleanup(dir);
});

test('granting twice is idempotent', () => {
  const dir = makeProfile(FULL_BLOCK);
  authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  const once = read(dir);
  const again = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'second grant must be a no-op');
  assert.equal(read(dir), once);

  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(plan.alreadyAllowed, true);
  assert.deepEqual(plan.replaces, []);
  cleanup(dir);
});

test('creates the allowBuilds section when the profile has none', () => {
  const dir = makeProfile(null);
  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(plan.hasSection, false);
  const result = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const text = read(dir);
  assert.ok(text.includes('allowBuilds:'), text);
  assert.ok(text.includes('  ' + allowKey(NAME, REPO, NEW) + ': true'), text);
  assert.ok(text.includes('nodeLinker: hoisted'), 'existing settings kept');
  cleanup(dir);
});

test('appends without disturbing a section that has no entry for the package', () => {
  const dir = makeProfile(['allowBuilds:', '  koffi: true']);
  authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  const lines = read(dir).split('\n');
  const header = lines.indexOf('allowBuilds:');
  assert.ok(header >= 0);
  assert.equal(lines[header + 1], '  koffi: true');
  assert.equal(lines[header + 2], '  ' + allowKey(NAME, REPO, NEW) + ': true');
  cleanup(dir);
});

test('a grant for one package never touches another package grant', () => {
  const dir = makeProfile(FULL_BLOCK);
  authorizeBuild({ profileDir: dir, name: 'dsh-client-masquerade', repo: 'ymh0000123/dsh-client-masquerade', sha: NEW });
  const text = read(dir);
  assert.ok(text.includes(NAME + '@' + tarballUrl(REPO, OLD) + ': true'), 'other package grant must survive');
  assert.ok(text.includes('dsh-client-masquerade@' + tarballUrl('ymh0000123/dsh-client-masquerade', NEW) + ': true'));
  cleanup(dir);
});

test('replaces pnpm\'s "set this to true or false" placeholder instead of duplicating it', () => {
  // pnpm rewrites a decided grant back to this placeholder when it wants the
  // user to choose again; an entry matcher that only accepts `: true` would
  // leave the placeholder behind and append a second entry.
  const dir = makeProfile([
    'allowBuilds:',
    '  koffi: true',
    '  ' + NAME + '@' + tarballUrl(REPO, OLD) + ': set this to true or false',
    '  protobufjs: true',
  ]);

  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: OLD });
  assert.equal(plan.alreadyAllowed, false, 'a placeholder is not a grant');
  assert.deepEqual(plan.replaces, [NAME + '@' + tarballUrl(REPO, OLD) + ': set this to true or false']);

  const result = authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: OLD });
  assert.equal(result.changed, true);
  const lines = read(dir).split('\n');
  assert.equal(lines.filter((l) => l.includes(NAME + '@')).length, 1, 'exactly one entry for the package');
  assert.equal(read(dir).includes('set this to true or false'), false, 'placeholder must be gone');
  assert.ok(read(dir).includes('  ' + allowKey(NAME, REPO, OLD) + ': true'));
  assert.ok(read(dir).includes('  koffi: true') && read(dir).includes('  protobufjs: true'));
  cleanup(dir);
});

test('replaces a false entry too', () => {
  const dir = makeProfile(['allowBuilds:', '  ' + NAME + '@' + tarballUrl(REPO, NEW) + ': false']);
  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(plan.alreadyAllowed, false);
  assert.equal(plan.replaces.length, 1);
  authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  const entries = read(dir).split('\n').filter((l) => l.includes(NAME + '@'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].trim(), allowKey(NAME, REPO, NEW) + ': true');
  cleanup(dir);
});

test('refuses to plan or write without a repo and commit', () => {
  const dir = makeProfile(FULL_BLOCK);
  const before = read(dir);
  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: '' });
  assert.equal(plan.ok, false);
  const result = authorizeBuild({ profileDir: dir, name: NAME, repo: '', sha: NEW });
  assert.equal(result.ok, false);
  assert.equal(read(dir), before);
  cleanup(dir);
});

test('reports a missing policy file instead of creating one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-ws-none-'));
  const plan = planAuthorization({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /pnpm-workspace\.yaml 不存在/);
  assert.equal(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')), false);
  cleanup(dir);
});

test('preserves CRLF line endings', () => {
  const dir = makeProfile(FULL_BLOCK);
  const file = path.join(dir, 'pnpm-workspace.yaml');
  fs.writeFileSync(file, read(dir).replace(/\n/g, '\r\n'), 'utf8');
  authorizeBuild({ profileDir: dir, name: NAME, repo: REPO, sha: NEW });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('\r\n'), true);
  assert.equal(/[^\r]\n/.test(text), false, 'must not mix bare LF into a CRLF file');
  cleanup(dir);
});
