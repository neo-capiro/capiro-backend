// Owned adversarial fixture: attempts a loopback TCP connect and then SWALLOWS
// the error, exiting 0 with no diagnostic on stdout/stderr. An errno-text / exit
// classifier sees a clean run; the denied-syscall audit must still record the
// connect attempt (see attempt-audit.mjs).
import net from 'node:net';
const sock = net.connect(9, '127.0.0.1');
sock.on('error', () => {
  sock.destroy();
  process.exit(0);
});
sock.on('connect', () => {
  sock.end();
  process.exit(0);
});
setTimeout(() => process.exit(0), 3000);
