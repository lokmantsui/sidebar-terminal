# Spawns $SHELL in a real pty. stdin -> pty, pty -> stdout, fd 3 receives "cols rows\n" resize lines.
import os, pty, select, struct, fcntl, termios

pid, fd = pty.fork()
if pid == 0:
    sh = os.environ.get("SHELL", "/bin/bash")
    os.execvp(sh, [sh, "-l"])

buf = b""
while True:
    r, _, _ = select.select([0, 3, fd], [], [])
    try:
        if fd in r:
            data = os.read(fd, 65536)
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if 3 in r:
            data = os.read(3, 1024)
            if not data:
                break
            buf += data
            *lines, buf = buf.split(b"\n")
            for line in lines:
                cols, rows = map(int, line.split())
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:  # shell exited
        break
