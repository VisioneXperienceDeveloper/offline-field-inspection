import {createFileStorage} from './src/storage.mjs';
import {loadConfig} from './src/config.mjs';
import {createFieldnoteServer} from './src/http.mjs';

const config = loadConfig();
const storage = await createFileStorage(config.dataFile);
const server = createFieldnoteServer({config, storage});

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(JSON.stringify({
    level: 'info', event: 'server_started', host: config.host, port, version: config.buildVersion,
  }));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({level: 'info', event: 'server_stopping', signal}));
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(error => {
    clearTimeout(forceExit);
    if (error) {
      console.error(JSON.stringify({level: 'error', event: 'server_stop_failed', message: error.message}));
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
