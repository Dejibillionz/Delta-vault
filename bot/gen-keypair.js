// Self-contained base58 decoder — no npm imports needed
// Run: node gen-keypair.js
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < ALPHABET.length; i++) BASE_MAP[ALPHABET.charCodeAt(i)] = i;

function decodeBase58(str) {
  const bytes = [0];
  for (const c of str) {
    let carry = BASE_MAP[c.charCodeAt(0)];
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of str) { if (c !== '1') break; bytes.push(0); }
  return new Uint8Array(bytes.reverse());
}

// Reads WALLET_PRIVATE_KEY_BASE58 from .env automatically
require('fs').readFileSync('.env', 'utf-8').split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k === 'WALLET_PRIVATE_KEY_BASE58' && v) process.env[k] = v.trim();
});

const key = process.env.WALLET_PRIVATE_KEY_BASE58;
if (!key) { console.error('WALLET_PRIVATE_KEY_BASE58 not found in .env'); process.exit(1); }

const bytes = decodeBase58(key);
require('fs').writeFileSync('./keypair.json', JSON.stringify(Array.from(bytes)));
console.log('keypair.json written —', bytes.length, 'bytes');
