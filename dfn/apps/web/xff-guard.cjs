'use strict';
/**
 * Client-address guard of the web server, preloaded with `node --require` (Docker image and
 * `pnpm start`). The /api/* proxy and the server-side API calls hand the API an X-Forwarded-For
 * that the API trusts (the web container sits in a TRUST_PROXY range): rate limits, audit and
 * session IPs are keyed on it. Next.js only fills that header when it is absent, so a client could
 * otherwise choose its own address.
 *
 * Before Next sees a request, X-Forwarded-For is replaced by a single address:
 *   - WEB_TRUSTED_PROXY_HOPS=0 (default, browsers connect to this server directly): the socket peer;
 *   - WEB_TRUSTED_PROXY_HOPS=N: the address N hops left of the peer in the chain appended by the N
 *     reverse proxies in front (only when this server is reachable through them alone).
 * Client-supplied Forwarded / X-Real-IP headers are dropped, and with no trusted hop the
 * X-Forwarded-Host/Proto/Port headers too (Next then derives them from the request itself).
 */
const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');

function readHops(raw) {
  const n = Number.parseInt(raw ?? '0', 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function clientAddress(req, hops) {
  const peer = req.socket?.remoteAddress ?? '';
  if (hops === 0) return peer;
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  chain.push(peer);
  const candidate = chain[Math.max(chain.length - 1 - hops, 0)];
  return isIP(candidate) ? candidate : peer;
}

function sanitize(req, hops) {
  const address = clientAddress(req, hops);
  delete req.headers.forwarded;
  delete req.headers['x-real-ip'];
  if (hops === 0) {
    delete req.headers['x-forwarded-host'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-port'];
  }
  if (address) req.headers['x-forwarded-for'] = address;
  else delete req.headers['x-forwarded-for'];
}

function install(hops = readHops(process.env.WEB_TRUSTED_PROXY_HOPS)) {
  for (const mod of [http, https]) {
    const original = mod.createServer;
    if (original.dfnGuarded) continue;
    const guarded = function createServer(...args) {
      const server = original.apply(this, args);
      server.prependListener('request', (req) => sanitize(req, hops));
      return server;
    };
    guarded.dfnGuarded = true;
    mod.createServer = guarded;
  }
}

install();

module.exports = { clientAddress, sanitize, readHops };
