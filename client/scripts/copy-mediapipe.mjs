/**
 * Self-host the MediaPipe face-detector WebAssembly runtime (no third-party CDN at
 * exam time; works under the app's CSP). Copies the SIMD and non-SIMD builds from
 * the installed @mediapipe/tasks-vision package into public/mediapipe/wasm.
 * Runs automatically before `dev` and `build`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mediapipe', 'wasm');
const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];

fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  const src = require.resolve(`@mediapipe/tasks-vision/${f}`);
  const dest = path.join(outDir, f);
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(src).size) fs.copyFileSync(src, dest);
}
console.log(`[mediapipe] runtime ready in ${path.relative(process.cwd(), outDir)}`);
