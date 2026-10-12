// Owned adversarial fixture: attempts a loopback TCP connect. Under
// `--network none` (loopback has no listener) this yields ECONNREFUSED, which
// the isolation boundary must surface as a NETWORK DENIAL — never a pass.
import net from 'node:net';
const sock = net.connect(9, '127.0.0.1');
sock.on('error', (e) => {
  console.log('NET_ERR', e.code);
  process.exit(3);
});
sock.on('connect', () => {
  console.log('NET_CONNECTED');
  process.exit(0);
});
setTimeout(() => {
  console.log('NET_NOEVENT');
  process.exit(4);
}, 4000);
