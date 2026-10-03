// node check.js — verifies ptyhost.py runs a shell, applies resize, and exits cleanly.
const p = require('child_process').spawn('python3', [__dirname + '/ptyhost.py'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: { ...process.env, SHELL: '/bin/bash' } });
let out = ''; p.stdout.on('data', (d) => (out += d));
p.stdio[3].write('123 45\n');
setTimeout(() => p.stdin.write('stty size; echo hi-$((40+2)); exit\n'), 500);
p.on('exit', () => { const ok = /45 123/.test(out) && /hi-42/.test(out); console.log(ok ? 'OK' : 'FAIL\n' + out); process.exit(ok ? 0 : 1); });
