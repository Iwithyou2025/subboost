import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cwd = path.resolve(__dirname, "../..");
describe("terminal input editing", () => {
  it.each(["prompt", "secret", "pem"])("supports BS and DEL for %s through a real controlling terminal", (mode) => {
    const result = spawnSync("python3", ["-", mode], { cwd, encoding: "utf8", timeout: 20000, input: String.raw`
import fcntl, os, pty, select, subprocess, sys, tempfile, termios, time
mode=sys.argv[1]
with tempfile.TemporaryDirectory() as work:
    master, slave=pty.openpty()
    def terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    env=dict(os.environ, SUBBOOST_SCRIPT_SOURCE_ONLY='1', SUBBOOST_ASSUME_YES='0', TERM='xterm')
    if mode=='prompt': command='value="$(prompt "READY: " "")"; printf "%s" "$value" > "$1"'
    elif mode=='secret': command='value="$(read_secret_from_tty "READY: ")"; printf "%s" "$value" > "$1"'
    else: command='read_pem_from_tty "$1" "READY"'
    p=subprocess.Popen(['bash','-c','source local/scripts/install.sh; '+command,'bash',work+'/out'], stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=terminal)
    os.close(slave)
    output=b''
    try:
        deadline=time.monotonic()+5
        while b'READY' not in output:
            if time.monotonic()>deadline: raise RuntimeError('prompt missing')
            if select.select([master],[],[],0.1)[0]: output+=os.read(master,4096)
        # Deliberately use both BS and DEL regardless of the terminal erase setting.
        payload=b'abcX\x08Y\x7fdef\n'
        expected=b'abcdef'
        if mode=='pem':
            payload=b'-----BEGIN CERTIFICATE-----\n'+payload+b'-----END CERTIFICATE-----\n\n'
            expected=b'-----BEGIN CERTIFICATE-----\nabcdef\n-----END CERTIFICATE-----\n'
        os.write(master,payload)
        p.wait(timeout=5)
        while select.select([master],[],[],0.1)[0]:
            try: output+=os.read(master,4096)
            except OSError: break
        assert p.returncode==0,output
        assert open(work+'/out','rb').read()==expected,open(work+'/out','rb').read()
        if mode=='secret': assert b'abc' not in output,output
    finally:
        if p.poll() is None: p.kill(); p.wait()
        os.close(master)
` });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
