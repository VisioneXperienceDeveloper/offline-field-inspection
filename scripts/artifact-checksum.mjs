import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';

const [rootArgument = 'dist/fieldnote', rawSchemaVersion = '2'] = process.argv.slice(2);
const databaseSchemaVersion = Number(rawSchemaVersion);
if (!Number.isSafeInteger(databaseSchemaVersion) || databaseSchemaVersion < 1) {
  throw new Error(`Invalid database schema version: ${rawSchemaVersion}`);
}
const root = resolve(rootArgument);
const manifestPath = resolve(root, 'artifact-manifest.json');

async function filesUnder(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return files.flat();
}

const files = (await filesUnder(root)).filter(path => path !== manifestPath).sort();
const artifacts = [];
for (const path of files) {
  const contents = await readFile(path);
  artifacts.push({path: relative(root, path), bytes: contents.byteLength, sha256: createHash('sha256').update(contents).digest('hex')});
}

const aggregate = createHash('sha256');
for (const artifact of artifacts) aggregate.update(`${artifact.sha256}  ${artifact.path}\n`);
let sourceSha = process.env['GITHUB_SHA'] ?? 'unknown';
if (sourceSha === 'unknown') {
  try { sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); } catch { /* non-git artifact */ }
}
const manifest = {algorithm: 'sha256', sourceSha, databaseSchemaVersion, artifactSha256: aggregate.digest('hex'), files: artifacts};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifest.artifactSha256}  ${rootArgument}`);
