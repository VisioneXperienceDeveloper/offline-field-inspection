import {cp, mkdir, rm} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

const [sourceArgument = 'server', outputArgument = 'dist/fieldnote-server'] = process.argv.slice(2);
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const distRoot = resolve('dist');

if (output === distRoot || !output.startsWith(`${distRoot}${sep}`)) {
  throw new Error(`Server package output must be a child of ${distRoot}.`);
}

await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
await Promise.all([
  cp(resolve(source, 'index.mjs'), resolve(output, 'index.mjs')),
  cp(resolve(source, 'src'), resolve(output, 'src'), {recursive: true}),
  cp(resolve(source, 'README.md'), resolve(output, 'README.md')),
]);
console.log(`Packaged ${sourceArgument} at ${outputArgument}`);
