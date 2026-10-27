import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { Gateway } from './logic/gateway.mjs';
import { attachSockets } from './views/socket.mjs';
import { internalHandler, publicHandler } from './views/http.mjs';
import { routes } from './generated/routes.mjs';
const gateway = new Gateway();
const config = await gateway.database.config();
const tls = {
  ca: await readFile(config.gateway.ca_file),
  cert: await readFile(config.gateway.cert_file),
  key: await readFile(config.gateway.key_file),
  requestCert: true,
  rejectUnauthorized: true,
};
const publicServer = http.createServer(publicHandler(gateway));
const internalServer = https.createServer(
  tls,
  internalHandler(gateway, config.gateway.token, routes),
);
const closeSockets = attachSockets(
  publicServer,
  gateway,
  process.env.CHAT_ALLOWED_ORIGIN,
  routes.socket,
);
gateway.start();
publicServer.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
internalServer.listen(Number(process.env.INTERNAL_PORT ?? 8443), '0.0.0.0');
const refresh = setInterval(async () => {
  try {
    internalServer.setSecureContext({
      ca: await readFile(config.gateway.ca_file),
      cert: await readFile(config.gateway.cert_file),
      key: await readFile(config.gateway.key_file),
    });
  } catch {
    /* Keep the last valid certificate until the next refresh. */
  }
}, 60000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(refresh);
  closeSockets();
  publicServer.close();
  internalServer.close();
  await gateway.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
