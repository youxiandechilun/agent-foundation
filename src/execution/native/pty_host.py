"""Foundation POSIX PTY bridge; only Python standard library and OS PTY syscalls."""
import os, sys, json, base64, pty, select, struct, fcntl, termios, signal

def send(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()

cfg = json.loads(sys.stdin.buffer.readline())
pid, master = pty.fork()
if pid == 0:
    os.chdir(cfg['cwd'])
    os.execvpe(cfg['command'], [cfg['command']] + cfg['args'], os.environ)

def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

resize(cfg.get('cols', 100), cfg.get('rows', 30))
send({'type': 'ready', 'pid': pid, 'backend': 'posix-pty'})
pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [], .1)
        if master in ready:
            try:
                data = os.read(master, 8192)
                if data: send({'type': 'data', 'data': base64.b64encode(data).decode()})
            except OSError: pass
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                req = json.loads(line)
                if req['op'] == 'write':
                    data = base64.b64decode(req['data'])
                    while data:
                        count = os.write(master, data)
                        data = data[count:]
                elif req['op'] == 'resize':
                    resize(req['cols'], req['rows'])
                    send({'type': 'resized'})
                elif req['op'] == 'stop': os.killpg(pid, signal.SIGKILL)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            # Drain terminal bytes before the terminal exit frame.
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 8192)
                    if not data: break
                    send({'type': 'data', 'data': base64.b64encode(data).decode()})
                except OSError: break
            send({'type': 'exit', 'exitCode': os.waitstatus_to_exitcode(status)})
            break
finally:
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(master)
