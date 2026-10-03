// npm run check — verifies ptyhost.py runs a shell, applies resize, and exits cleanly.
import { spawn } from 'child_process';
import * as path from 'path';
import type { Readable, Writable } from 'stream';
import type { ChildProcessByStdio } from 'child_process';

const p = spawn('python3', [path.join(__dirname, '..', '..', 'ptyhost.py')], {
  stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  env: { ...process.env, SHELL: '/bin/bash' },
}) as ChildProcessByStdio<Writable, Readable, null>;
let out = '';
p.stdout.on('data', (d: Buffer) => (out += d));
(p.stdio[3] as Writable).write('123 45\n');
setTimeout(() => p.stdin.write('stty size; echo hi-$((40+2)); exit\n'), 500);
p.on('exit', () => {
  const ok = /45 123/.test(out) && /hi-42/.test(out);
  console.log(ok ? 'OK' : 'FAIL\n' + out);
  process.exit(ok ? 0 : 1);
});
