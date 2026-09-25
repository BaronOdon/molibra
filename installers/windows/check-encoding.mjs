// Fails (exit 1) if a file holds UTF-8 that was mis-read as ANSI and written back.
// 1.0.2's window shipped with such text; build.ps1 runs this before compiling.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const s = readFileSync(file, 'utf8');
const bad = s.match(/â[\u0080-¿€™“”›]|Ã[\u0080-¿]/g) ?? [];
if (bad.length) {
  console.error(`${file}: ${bad.length} mis-encoded sequence(s), e.g. ${JSON.stringify(bad.slice(0, 3))}`);
  process.exit(1);
}
console.log(`${file}: encoding clean`);
