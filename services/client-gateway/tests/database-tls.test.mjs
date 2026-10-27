import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseIdentity } from '../../../libs/chat_runtime/src/database-tls.mjs';

test('database TLS validates the configured IP, not the wrapped socket localhost', () => {
  const verify = databaseIdentity('10.77.26.11');
  assert.equal(
    verify('localhost', {
      subjectaltname: 'DNS:node-yc, IP Address:10.77.26.11',
    }),
    undefined,
  );
  assert.equal(
    verify('localhost', {
      subjectaltname: 'DNS:localhost, IP Address:10.77.26.12',
    }).code,
    'ERR_TLS_CERT_ALTNAME_INVALID',
  );
});

test('database TLS still rejects a mismatched DNS identity', () => {
  const verify = databaseIdentity('db.example.test');
  assert.equal(
    verify('localhost', { subjectaltname: 'DNS:db.example.test' }),
    undefined,
  );
  assert.equal(
    verify('localhost', { subjectaltname: 'DNS:other.example.test' }).code,
    'ERR_TLS_CERT_ALTNAME_INVALID',
  );
});
