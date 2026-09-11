const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const dir = resolve(process.argv[2]);
const port = Number(process.argv[3]);
const next = createRequire(resolve(dir, 'package.json'))('next');
const app = next({ dev: true, dir, hostname: 'localhost', port, webpack: true });
const server = createServer((req, res) => app.getRequestHandler()(req, res));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 10000);
  try {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
    clearTimeout(timer);
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
}
process.on('message', message => { if (message === 'shutdown') void close(); });
process.on('disconnect', () => void close());
server.on('error', error => { console.error(error); process.exit(1); });
app.prepare().then(() => server.listen(port, 'localhost', () => process.send?.({ ready: port }))).catch(error => {
  console.error(error);
  process.exit(1);
});
