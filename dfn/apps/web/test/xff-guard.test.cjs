'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clientAddress, readHops } = require('../xff-guard.cjs');
// The guard is installed when required: servers created from here on are sanitised.
const http = require('node:http');

const fakeReq = (xff, peer) => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: peer },
});

test('without a trusted hop the socket peer wins over any client-supplied header', () => {
  assert.equal(clientAddress(fakeReq('203.0.113.9', '198.51.100.7'), 0), '198.51.100.7');
  assert.equal(clientAddress(fakeReq(undefined, '198.51.100.7'), 0), '198.51.100.7');
});

test('with N trusted hops the address N hops left of the peer is kept', () => {
  // Client spoofs 1.1.1.1; the reverse proxy appends the real client 203.0.113.9; peer is the proxy.
  assert.equal(clientAddress(fakeReq('1.1.1.1, 203.0.113.9', '10.0.0.2'), 1), '203.0.113.9');
  assert.equal(clientAddress(fakeReq('203.0.113.9, 10.0.0.3', '10.0.0.2'), 2), '203.0.113.9');
  // Shorter chain than configured: leftmost entry; garbage falls back to the peer.
  assert.equal(clientAddress(fakeReq(undefined, '10.0.0.2'), 1), '10.0.0.2');
  assert.equal(clientAddress(fakeReq('not-an-ip', '10.0.0.2'), 1), '10.0.0.2');
});

test('hop count parsing', () => {
  assert.equal(readHops(undefined), 0);
  assert.equal(readHops('2'), 2);
  assert.equal(readHops('-1'), 0);
  assert.equal(readHops('abc'), 0);
});

test('a real server sees the peer address, not the spoofed headers', async () => {
  const seen = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.end();
      server.close();
      resolve(req.headers);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      http
        .get(
          {
            port,
            host: '127.0.0.1',
            agent: false,
            headers: {
              'x-forwarded-for': '203.0.113.9',
              'x-real-ip': '203.0.113.9',
              forwarded: 'for=203.0.113.9',
              'x-forwarded-host': 'evil.example',
            },
          },
          (res) => res.resume(),
        )
        .on('error', reject);
    });
  });
  assert.equal(seen['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen['x-real-ip'], undefined);
  assert.equal(seen.forwarded, undefined);
  assert.equal(seen['x-forwarded-host'], undefined);
});
