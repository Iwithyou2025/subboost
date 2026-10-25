import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cwd = path.resolve(__dirname, "../..");
describe("terminal input editing", () => {
  const cases = ["direct", "pipe"].flatMap((transport) =>
    ["prompt", "number", "domain", "default", "eof", "interrupt", "secret", "pem", "local", "server-auto", "server-import"]
      .map((mode) => [transport, mode]),
  );

  it.each(cases)("handles visible input, editing and terminal restoration for %s / %s", (transport, mode) => {
    const result = spawnSync("python3", ["-", transport, mode], { cwd, encoding: "utf8", timeout: 20000, input: String.raw`
import errno, fcntl, os, pathlib, pty, select, signal, subprocess, sys, tempfile, termios, time
transport, mode=sys.argv[1:]
with tempfile.TemporaryDirectory() as work:
    master, slave=pty.openpty()
    original_state=termios.tcgetattr(slave)
    def terminal():
        os.setsid()
        fcntl.ioctl(1, termios.TIOCSCTTY, 0)
    env=dict(os.environ, SUBBOOST_SCRIPT_SOURCE_ONLY='1', SUBBOOST_ASSUME_YES='0', TERM='xterm', INPUTRC='/dev/null', LC_ALL='C.UTF-8')
    if mode=='secret':
        command='value="$(read_secret_from_tty "READY: ")"; printf "%s" "$value" > "$1"; value="$(prompt "AFTER: " "")"; printf "|%s" "$value" >> "$1"'
    elif mode=='pem': command='read_pem_from_tty "$1" "certificate"'
    elif mode in ('local', 'server-auto', 'server-import'):
        command='''
INSTALL_MODE= HTTPS_DOMAIN= TLS_MODE= imported=no
https_dependencies() { :; }
https_dns_preflight() { :; }
collect_https_certificate() { imported=yes; }
select_install_mode
printf '%s|%s|%s|%s' "$INSTALL_MODE" "$HTTPS_DOMAIN" "$TLS_MODE" "$imported" > "$1"
'''
    else: command='value="$(prompt "READY: " "1")"; printf "%s" "$value" > "$1"'
    runner=pathlib.Path(work, 'runner.sh')
    runner.write_text('source local/scripts/install.sh\n'+command+'\nprintf "|finished" >> "$1"\n')
    # Match a user's interactive shell: the script/pipeline owns a foreground
    # process group, so Ctrl+C reaches it while the launcher waits separately.
    launch='bash "$1" "$2"' if transport=='direct' else 'cat "$1" | bash -s -- "$2"'
    args=['bash','--noprofile','--norc','-i','-c',launch,'bash',str(runner),work+'/out']
    p=subprocess.Popen(args, stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=terminal)
    output=b''
    def receive(timeout=0.05):
        global output
        if select.select([master],[],[],timeout)[0]:
            try: output+=os.read(master,4096)
            except OSError as error:
                if error.errno!=errno.EIO: raise
    def wait_for(predicate, reason):
        deadline=time.monotonic()+3
        while not predicate():
            if time.monotonic()>deadline: raise AssertionError((reason,output))
            receive()
    def ready(marker, start=0):
        wait_for(lambda: marker.encode() in output[start:], 'prompt missing: '+marker)
        # PEM uses canonical terminal input so pasted multiline blocks are read line by line.
        if mode=='pem':
            wait_for(lambda: bool(termios.tcgetattr(slave)[3] & termios.ICANON), 'canonical reader not ready')
        else:
            wait_for(lambda: not termios.tcgetattr(slave)[3] & termios.ICANON, 'reader not ready')
    def type_visible(payload, visible):
        start=len(output)
        os.write(master,payload)
        wait_for(lambda: visible in output[start:], 'input did not echo before Enter')
    def answer(marker, payload, visible, start=0):
        ready(marker,start)
        if payload: type_visible(payload,visible)
        checkpoint=len(output)
        os.write(master,b'\n')
        return checkpoint
    try:
        # Deliberately use both BS and DEL regardless of the terminal erase setting.
        edited=b'abcX\x08Y\x7fdef'
        if mode=='local':
            answer('请选择 [1]: ',b'1',b'1')
            expected=b'local|||no'
        elif mode.startswith('server-'):
            checkpoint=0
            if mode=='server-auto':
                checkpoint=answer('请选择 [1]: ',b'9',b'9')
                wait_for(lambda: '请输入 1 或 2。'.encode() in output, 'invalid choice not rejected')
            checkpoint=answer('请选择 [1]: ',b'2',b'2',checkpoint)
            checkpoint=answer('请输入访问域名（不含路径）: ',b'invalid_domain',b'invalid_domain',checkpoint)
            wait_for(lambda: '域名格式无效'.encode() in output, 'invalid domain not rejected')
            checkpoint=answer('请输入访问域名（不含路径）: ',b'sub.example.test',b'sub.example.test',checkpoint)
            if mode=='server-auto':
                checkpoint=answer('请选择 [1]: ',b'9',b'9',checkpoint)
                answer('请选择 [1]: ',b'1',b'1',checkpoint)
                expected=b'server|sub.example.test|auto|no'
            else:
                answer('请选择 [1]: ',b'2',b'2',checkpoint)
                expected=b'server|sub.example.test|import|yes'
        elif mode=='secret':
            ready('READY: ')
            type_visible(edited,b'def')
            checkpoint=len(output)
            os.write(master,b'\n')
            answer('AFTER: ',b'2',b'2',checkpoint)
            expected=b'abcdef|2'
        elif mode=='pem':
            ready('请粘贴完整certificate')
            cert=pathlib.Path(work,'test-cert.pem')
            key=pathlib.Path(work,'test-key.pem')
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-subj','/CN=example.test','-days','1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            payload=cert.read_bytes()
            type_visible(payload,b'-----END CERTIFICATE-----')
            expected=payload
        elif mode in ('eof','interrupt'):
            ready('READY: ')
            if mode=='interrupt':
                # Cancel an active read, after readline has processed input and
                # installed its signal handlers (not midway through tty setup).
                type_visible(b'cancel-me',b'cancel-me')
            os.write(master,b'\x04' if mode=='eof' else b'\x03')
            expected=b'1'
        else:
            payload,expected={'prompt':(edited,b'abcdef'), 'number':(b'2',b'2'), 'domain':(b'sub.example.test',b'sub.example.test'), 'default':(b'',b'1')}[mode]
            answer('READY: ',payload,b'def' if mode=='prompt' else payload)
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            receive(0)
            raise AssertionError(('terminal process did not exit',p.args,output))
        while select.select([master],[],[],0.05)[0]: receive(0)
        wait_for(lambda: termios.tcgetattr(slave)==original_state, 'terminal settings were not restored')
        if mode=='interrupt':
            assert p.returncode!=0,output
            assert not pathlib.Path(work,'out').exists(),'cancelled input was accepted'
        else:
            assert p.returncode==0,output
            assert pathlib.Path(work,'out').read_bytes()==expected+b'|finished',pathlib.Path(work,'out').read_bytes()
            if mode=='secret': assert b'def' in output and b'READY: ' in output and b'AFTER: ' in output,output
    finally:
        if p.poll() is None: os.killpg(p.pid,signal.SIGKILL); p.wait()
        os.close(master); os.close(slave)
` });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 20000);
});
