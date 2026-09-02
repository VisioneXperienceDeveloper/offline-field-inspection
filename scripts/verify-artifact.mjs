import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

const [rootArgument = 'dist/fieldnote'] = process.argv.slice(2);
const root = resolve(rootArgument);
const manifest = JSON.parse(await readFile(resolve(root, 'artifact-manifest.json'), 'utf8'));

if (manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files) || typeof manifest.artifactSha256 !== 'string') {
  throw new Error('Artifact manifest has an unsupported shape.');
}

const aggregate = createHash('sha256');
for (const artifact of manifest.files) {
  const path = resolve(root, artifact.path);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Artifact path escapes root: ${artifact.path}`);
  const contents = await readFile(path);
  const checksum = createHash('sha256').update(contents).digest('hex');
  if (checksum !== artifact.sha256 || contents.byteLength !== artifact.bytes) throw new Error(`Artifact verification failed: ${artifact.path}`);
  aggregate.update(`${checksum}  ${artifact.path}\n`);
}

const artifactSha256 = aggregate.digest('hex');
if (artifactSha256 !== manifest.artifactSha256) throw new Error('Aggregate artifact checksum does not match the manifest.');
console.log(`${artifactSha256}  ${rootArgument} verified (${manifest.files.length} files)`);
