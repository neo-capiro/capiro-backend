import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import cp from 'node:child_process';
const controls = [
  ['nonlocal bind', () => net.createServer().listen(0, '0.0.0.0')],
  ['non-ephemeral bind', () => net.createServer().listen(12345, '127.0.0.1')],
  ['unowned local port', () => new net.Socket().connect({ host: '127.0.0.1', port: 12345 })],
  ['external address', () => new net.Socket().connect({ host: '192.0.2.1', port: 80 })],
  ['nonliteral DNS', () => dns.lookup('example.invalid', () => {})],
  ['TLS connection', () => tls.connect({ host: '127.0.0.1', port: 12345 })],
  ['child process', () => cp.spawn('node', ['--version'])],
  ['fetch', () => fetch('https://example.invalid/')],
  ['protected source', () => fs.readFileSync('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts')],
];
const results = controls.map(([name, call]) => { assert.throws(call, /Source mock host refused/); return { name, refusedBeforeOriginalPort: true }; });
console.log(JSON.stringify({ results, pass: results.length, scope: 'own evidence-preload controls, not general syscall containment' }, null, 2));
