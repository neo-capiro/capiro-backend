const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = __dirname, index = 'SHA256-INDEX.json';
const files = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Packet symlink refused');
    if (stat.isDirectory()) walk(file);
    else if (path.relative(root, file) !== index) {
      const bytes = fs.readFileSync(file), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (name.endsWith('.lossless.json')) {
        const raw = JSON.parse(bytes), decoded = Buffer.from(raw.data, 'base64');
        if (decoded.length !== raw.bytes || crypto.createHash('sha256').update(decoded).digest('hex') !== raw.sha256) throw new Error(`Lossless observation mismatch:${name}`);
      }
      files.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.length, sha256 });
    }
  }
}
walk(root);
fs.writeFileSync(path.join(root, index), JSON.stringify({ algorithm: 'sha256', files }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ sealedPayloads: files.length, losslessRawObservations: files.filter(x => x.path.endsWith('.lossless.json')).length }) + '\n');
