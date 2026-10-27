import { checkServerIdentity } from 'node:tls';

export function databaseIdentity(host) {
  return (_servername, certificate) => checkServerIdentity(host, certificate);
}
