import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, resolve, sep} from 'node:path';

const [rootArgument = 'dist/fieldnote', rawPort = '4173'] = process.argv.slice(2);
const root = resolve(rootArgument);
const port = Number(rawPort);
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${rawPort}`);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  const candidate = resolve(root, `.${pathname}`);

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let file = candidate;
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    await stat(file);
  } catch {
    if (extname(pathname)) {
      response.writeHead(404).end('Not found');
      return;
    }
    file = resolve(root, 'index.html');
  }

  const fileName = file.slice(file.lastIndexOf(sep) + 1);
  const revalidatedFiles = new Set([
    'artifact-manifest.json',
    'index.html',
    'manifest.webmanifest',
    'ngsw-worker.js',
    'ngsw.json',
  ]);
  response.setHeader(
    'Cache-Control',
    revalidatedFiles.has(fileName) ? 'no-cache' : 'public, max-age=31536000, immutable',
  );
  response.setHeader('Content-Type', contentTypes.get(extname(file)) ?? 'application/octet-stream');
  if (request.method === 'HEAD') {
    response.writeHead(200).end();
    return;
  }
  createReadStream(file).on('error', () => response.writeHead(500).end('Unable to read artifact.')).pipe(response);
});

server.listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${port}`));
