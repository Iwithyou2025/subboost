import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cwd = path.resolve(__dirname, "../..");
function run(body: string, manager = false) {
  return spawnSync("bash", ["-s"], {
    cwd, encoding: "utf8", timeout: 30_000,
    input: `set -Eeuo pipefail
export SUBBOOST_SCRIPT_SOURCE_ONLY=1 SUBBOOST_ASSUME_YES=1
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export SUBBOOST_HOME="$work/home"
mkdir -p "$SUBBOOST_HOME"
source local/scripts/${manager ? "subboost" : "install"}.sh
TMP_DIR="$work/tmp"
mkdir -p "$TMP_DIR"
${body}`,
  });
}

describe("HTTPS installation", () => {
  it("accepts hostnames but rejects configuration injection, IPs and malformed labels", () => {
    const r = run(`
valid_https_domain x.bitwise.hidns.co
valid_https_domain a-b.example.com
for domain in 'example.com:443' 'a..com' '-a.example.com' 'a.example.com.' '127.0.0.1' 'x.com/path' 'x.com {' '*.example.com'; do
  if valid_https_domain "$domain"; then exit 10; fi
done
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("preserves the default local install without DNS or dependency installation", () => {
    const r = run(`
https_dependencies() { exit 40; }
select_install_mode
[ "$INSTALL_MODE" = local ]
prepare_https_config
[ ! -e "$SUBBOOST_HOME/https-compose.yml" ]
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails a busy 443 before writing any configuration", () => {
    const r = run(`INSTALL_MODE=server
port_is_free() { return 1; }
prepare_https_config`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("443 已被占用");
  });

  it("rejects old Compose rather than merging an unsafe public binding", () => {
    const r = run(`INSTALL_MODE=server
port_is_free() { return 0; }
docker_cmd() { echo 2.24.3; }
prepare_https_config`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("2.24.4");
  });

  it("generates automatic HTTPS with loopback-only HTTP and preserves encryption keys", () => {
    const r = run(`
INSTALL_MODE=server; TLS_MODE=auto; HTTPS_DOMAIN=x.example.com
port_is_free() { return 0; }
docker_cmd() { echo 2.40.3; }
random_free_port() { echo 38872; }
export APP_URL=http://wrong.example.com SUBBOOST_PORT=12345 TRUST_PROXY_HEADERS=true
printf 'ENCRYPTION_KEY=keep-this-key\nAPP_URL=http://old:3000\n' > "$ENV_FILE"
prepare_https_config
[ "$(env_value ENCRYPTION_KEY)" = keep-this-key ]
[ "$(env_value APP_URL)" = https://x.example.com ]
[ -z "\${APP_URL+x}" ]
[ -z "\${SUBBOOST_PORT+x}" ]
grep -q 'ports: !override' "$SUBBOOST_HOME/https-compose.yml"
grep -Fq '127.0.0.1:\${SUBBOOST_PORT}:3000' "$SUBBOOST_HOME/https-compose.yml"
grep -q disable_http_challenge "$SUBBOOST_HOME/https/Caddyfile"
grep -q 'header_down -Referrer-Policy' "$SUBBOOST_HOME/https/Caddyfile"
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("checks certificate domain, expiry and matching RSA/EC private keys", () => {
    const r = run(`
warn() { printf '%s\n' "$*" >&2; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key" -out "$work/cert" -days 3 -subj /CN=x.example.com -addext subjectAltName=DNS:x.example.com 2>/dev/null
validate_https_certificate "$work/cert" "$work/key" x.example.com
if validate_https_certificate "$work/cert" "$work/key" wrong.example.com; then exit 1; fi
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/other" 2>/dev/null
if validate_https_certificate "$work/cert" "$work/other" x.example.com; then exit 2; fi
openssl req -x509 -new -key "$work/other" -out "$work/eccert" -days 3 -subj /CN=x.example.com -addext subjectAltName=DNS:x.example.com 2>/dev/null
validate_https_certificate "$work/eccert" "$work/other" x.example.com
openssl req -x509 -new -key "$work/other" -out "$work/short" -days 1 -subj /CN=x.example.com 2>/dev/null
if validate_https_certificate "$work/short" "$work/other" x.example.com; then exit 3; fi
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("imports file certificates without exposing a private key in output", () => {
    const r = run(`
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key" -out "$work/cert" -days 3 -subj /CN=x.example.com 2>/dev/null
export SUBBOOST_TLS_CERT_FILE="$work/cert" SUBBOOST_TLS_KEY_FILE="$work/key"
HTTPS_DOMAIN=x.example.com
collect_https_certificate
cmp "$work/key" "$TMP_DIR/origin.key"
[ "$(stat -c %a "$TMP_DIR/origin.key")" = 600 ]
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("BEGIN PRIVATE KEY");
  });

  it("retries network failures with a finite limit", () => {
    const r = run(`
count=0
sleep() { :; }
flaky() { count=$((count+1)); [ "$count" -eq 3 ]; }
retry_network flaky
[ "$count" -eq 3 ]
count=0
broken() { count=$((count+1)); return 1; }
if retry_network broken; then exit 1; fi
[ "$count" -eq 3 ]
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("manager includes HTTPS override for candidate update and delete commands", () => {
    const r = run(`
: > "$ENV_FILE"; : > "$COMPOSE_FILE"; : > "$SUBBOOST_HOME/https-compose.yml"
docker_cmd() { printf '%s\n' "$*"; }
compose_files "$ENV_FILE" "$COMPOSE_FILE" up -d app
compose down --volumes --remove-orphans
`, true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/https-compose.yml/g)).toHaveLength(2);
  });

  it("manager fails closed if a server override is missing", () => {
    const r = run(`
printf 'SUBBOOST_INSTALL_MODE=server\n' > "$ENV_FILE"
: > "$COMPOSE_FILE"
compose up -d
`, true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("HTTPS 配置缺失");
  });

  it("reports Cloudflare 522 separately from local TLS failures", () => {
    const r = run(`
INSTALL_MODE=server; TLS_MODE=import; HTTPS_DOMAIN=x.example.com
compose() { return 0; }
https_dns_preflight() { return 0; }
curl() { case "$*" in *--resolve*) return 0;; *) printf 522;; esac; }
if https_start_and_check; then exit 1; fi
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Cloudflare 522");
  });
  it("accepts multiline PEM from a real TTY without echoing secret input", () => {
    const r = run(`
python3 - "$PWD/local/scripts/install.sh" "$work/pasted" <<'PYTTY'
import fcntl, os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
env = dict(os.environ, SUBBOOST_ASSUME_YES='0')
p = subprocess.Popen(['bash', '-c', 'source "$1"; read_pem_from_tty "$2" private-key', 'bash', sys.argv[1], sys.argv[2]],
                     stdin=slave, stdout=slave, stderr=slave, env=env, preexec_fn=terminal)
os.close(slave)
output=b''
deadline=time.monotonic()+10
try:
    while b'private-key' not in output and time.monotonic()<deadline:
        if select.select([master],[],[],0.1)[0]: output+=os.read(master,4096)
    # read -s has disabled echo before submitting clipboard input.
    while termios.tcgetattr(master)[3] & termios.ECHO:
        if time.monotonic()>deadline: raise RuntimeError('terminal did not hide input')
        time.sleep(0.01)
    payload=b'-----BEGIN PRIVATE KEY-----\\nsecret-test-payload\\n-----END PRIVATE KEY-----\\n'
    os.write(master,payload+b'DONE\\n')
    p.wait(timeout=5)
    while select.select([master],[],[],0.1)[0]:
        try: output+=os.read(master,4096)
        except OSError: break
    assert p.returncode==0, output
    assert open(sys.argv[2],'rb').read()==payload
    assert b'secret-test-payload' not in output, output
finally:
    if p.poll() is None: p.kill()
    os.close(master)
PYTTY
`);
    expect(r.status, r.stderr).toBe(0);
  });

});

const dnsFixture = String.raw`
mkdir -p "$work/bin" "$work/python"
cat > "$work/python/socket.py" <<'PY'
SOCK_STREAM=1
def getaddrinfo(*args, **kwargs):
    return [(0,0,0,0,('104.21.23.170',443)),(0,0,0,0,('2606:4700:3034::6815:17aa',443))]
PY
cat > "$work/bin/curl" <<'PY'
#!/usr/bin/env python3
import json, os, sys
url=sys.argv[-1]
provider='GOOGLE' if 'dns.google' in url else 'CF'
mode=os.environ.get('DNS_TEST_'+provider, 'direct')
kind=28 if 'type=AAAA' in url else 1
if mode=='timeout' or (mode=='ipv6fail' and kind==28): sys.exit(28)
if mode=='malformed': print('not-json'); sys.exit(0)
address='104.21.23.170' if mode=='proxy' else ('170.9.22.172' if mode=='other' else '170.9.22.171')
answers=[] if kind==28 else [{'type':1,'data':address,'TTL':60}]
if kind==28 and mode in ('proxy','ipv6proxy'):
    answers=[{'type':28,'data':'2606:4700:3034::6815:17aa','TTL':60}]
if mode=='nxdomain': answers=[]
print(json.dumps({'Status':3 if mode=='nxdomain' else 0, 'Answer':answers}))
PY
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH" PYTHONPATH="$work/python"
HTTPS_DOMAIN=example.com
TLS_MODE=auto
`;

describe("HTTPS recovery regressions", () => {
  it("rejects Cloudflare IPv4 and IPv6 before auto TLS, but allows imported certificates", () => {
    const r = run(dnsFixture + String.raw`
export DNS_TEST_CF=proxy DNS_TEST_GOOGLE=proxy
if https_dns_preflight; then exit 10; fi
TLS_MODE=import
https_dns_preflight
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Cloudflare 代理地址");
  });

  it("does not create services when noninteractive DNS preflight fails", () => {
    const r = run(String.raw`
INSTALL_MODE=server HTTPS_DOMAIN=example.com TLS_MODE=auto
https_dependencies() { :; }
https_dns_preflight() { return 1; }
select_install_mode
printf 'SHOULD_NOT_CONTINUE'
`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("尚未创建服务");
    expect(r.stdout).not.toContain("SHOULD_NOT_CONTINUE");
  });

  it("supports help without an installed environment or Docker", () => {
    const r = run("main --help\nmain help\nmain -h", true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("--resume-https");
  });

  it("stops restore before validating or dumping when the database is not ready", () => {
    const r = run(String.raw`
load_env() { :; }
resolve_restore_inputs() { RESTORE_ENV=unused; RESTORE_DUMP=unused; }
compose() { echo "compose:$*"; }
wait_for_database_with_files() { return 1; }
verify_dump_file() { echo UNSAFE; }
create_verified_dump() { echo UNSAFE; }
restore_cmd unused.zip
`, true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("数据库未就绪");
    expect(r.stdout).not.toContain("UNSAFE");
    expect(r.stdout).not.toContain("stop cron");
  });

  it("blocks external Caddy network occupancy without deleting anything", () => {
    const r = run(String.raw`
docker_cmd() {
  case "$*" in
    'network ls '*) echo net ;;
    'network inspect '*) echo foreign ;;
    *com.docker.compose.project*) echo subboost-https ;;
    *'.Name'*) echo /subboost-https-caddy-1 ;;
    *) echo UNEXPECTED; return 1 ;;
  esac
}
delete_network_preflight subboost
`, true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("删除数据库前停止");
    expect(r.stdout).toContain("/opt/subboost-https/compose.yml down");
    expect(r.stdout).not.toContain("UNEXPECTED");
  });

  it("allows project-owned Caddy during delete preflight", () => {
    const r = run(String.raw`
docker_cmd() {
  case "$*" in
    'network ls '*) echo net ;;
    'network inspect '*) echo own ;;
    *com.docker.compose.project*) echo subboost ;;
    *) return 1 ;;
  esac
}
delete_network_preflight subboost
`, true);
    expect(r.status, r.stderr).toBe(0);
  });

  it("resumes HTTPS without restoring data or changing the existing app port", () => {
    const r = run(String.raw`
RESUME_HTTPS=1
printf 'SUBBOOST_INSTALL_MODE=server\nAPP_URL=https://example.com\nSUBBOOST_PORT=38872\nENCRYPTION_KEY=original\n' > "$ENV_FILE"
touch "$COMPOSE_FILE" "$SUBBOOST_HOME/https-compose.yml"
mkdir -p "$SUBBOOST_HOME/https"
echo original > "$SUBBOOST_HOME/https/Caddyfile"
select_install_mode() { TLS_MODE=auto; }
prepare_https_config() { echo updated > "$SUBBOOST_HOME/https/Caddyfile"; }
compose() { case "$*" in *db*|*app*|*pg_restore*) exit 99 ;; esac; echo "compose:$*"; }
https_start_and_check() { :; }
resume_https
grep -q '^SUBBOOST_PORT=38872$' "$ENV_FILE"
grep -q '^ENCRYPTION_KEY=original$' "$ENV_FILE"
grep -q updated "$SUBBOOST_HOME/https/Caddyfile"
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("未恢复或替换数据库");
  });

  it("restores prior HTTPS settings if a replacement configuration fails validation", () => {
    const r = run(String.raw`
RESUME_HTTPS=1
printf 'SUBBOOST_INSTALL_MODE=server\nAPP_URL=https://example.com\n' > "$ENV_FILE"
touch "$COMPOSE_FILE" "$SUBBOOST_HOME/https-compose.yml"
mkdir -p "$SUBBOOST_HOME/https"
echo original > "$SUBBOOST_HOME/https/Caddyfile"
select_install_mode() { TLS_MODE=import; }
prepare_https_config() { echo broken > "$SUBBOOST_HOME/https/Caddyfile"; echo changed > "$ENV_FILE"; }
compose() { return 1; }
if (resume_https); then exit 99; fi
grep -q original "$SUBBOOST_HOME/https/Caddyfile"
grep -q SUBBOOST_INSTALL_MODE=server "$ENV_FILE"
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("已恢复旧配置");
  });
});

describe("installer output, local restore and fresh public DNS", () => {
  it("accepts agreeing public DNS despite stale system cache and re-queries on retry", () => {
    const r = run(dnsFixture + String.raw`
export DNS_TEST_CF=proxy DNS_TEST_GOOGLE=proxy
if https_dns_preflight; then exit 10; fi
export DNS_TEST_CF=direct DNS_TEST_GOOGLE=direct
https_dns_preflight
[ "$DNS_PUBLIC_ADDRESS" = 170.9.22.171 ]
[ "$DNS_LOCAL_STALE" = 1 ]
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("无需重启脚本");
  });

  it.each(["ipv6proxy", "other", "nxdomain"])("blocks incomplete propagation: %s", (mode) => {
    const r = run(dnsFixture + `export DNS_TEST_GOOGLE=${mode}\nhttps_dns_preflight`);
    expect(r.status).not.toBe(0);
  });

  it("uses a complete provider if another times out, without treating failure as proxy state", () => {
    const r = run(dnsFixture + "export DNS_TEST_GOOGLE=timeout\nhttps_dns_preflight");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("一个公共 DNS 不可用");
  });

  it("does not treat unavailable AAAA lookup as absent AAAA records", () => {
    const r = run(dnsFixture + "export DNS_TEST_GOOGLE=ipv6fail DNS_TEST_CF=ipv6fail\nhttps_dns_preflight");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("公共 DNS 查询失败");
    expect(r.stderr).not.toContain("橙云仍开启");
  });

  it("rejects malformed replies", () => {
    const r = run(dnsFixture + "export DNS_TEST_GOOGLE=malformed DNS_TEST_CF=malformed\nhttps_dns_preflight");
    expect(r.status).not.toBe(0);
  });

  it("hides successful command output, preserves shell state and reports failed command status", () => {
    const r = run(String.raw`
noisy() { RESULT=retained; echo 'INTERNAL_SUCCESS_LOG'; }
run_step '启动服务' noisy
[ "$RESULT" = retained ]
fail() { echo 'CONNECTION_REFUSED' >&2; return 17; }
if run_step '失败阶段' fail; then exit 10; else [ "$?" = 17 ]; fi
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("INTERNAL_SUCCESS_LOG");
    expect(r.stderr).toContain("CONNECTION_REFUSED");
    expect(r.stdout).toContain("启动服务：完成");
  });

  it("replaces restored URL and port without changing encryption keys or using stale exported values", () => {
    const r = run(String.raw`
printf 'APP_URL=http://192.168.0.156:38872\nSUBBOOST_PORT=38872\nENCRYPTION_KEY=original\n' > "$ENV_FILE"
export APP_URL=http://old:38872 SUBBOOST_PORT=38872
prompt() { echo ''; }
random_free_port() { echo 45678; }
port_is_free() { [ "$1" = 45678 ]; }
detect_local_host() { echo 192.168.10.25; }
configure_restored_local_access
grep -q '^APP_URL=http://192.168.10.25:45678$' "$ENV_FILE"
grep -q '^SUBBOOST_PORT=45678$' "$ENV_FILE"
grep -q '^ENCRYPTION_KEY=original$' "$ENV_FILE"
! printenv APP_URL
! printenv SUBBOOST_PORT
`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("reports failed local IP detection and refuses to reuse the old URL", () => {
    const r = run(String.raw`
printf 'APP_URL=http://old:3000\n' > "$ENV_FILE"
prompt() { echo ''; }
random_free_port() { echo 45678; }
port_is_free() { return 0; }
detect_local_host() { return 1; }
configure_restored_local_access
`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("无法自动获取本机 IPv4");
    expect(r.stdout).not.toContain("本次本地访问地址");
  });
});

describe("restored local input validation", () => {
  it("re-prompts a busy port and accepts a manual address when detection fails", () => {
    const r = run(String.raw`
printf 'APP_URL=http://old:3000\n' > "$ENV_FILE"
printf '1\n' > "$work/input-index"
prompt() {
  n="$(cat "$work/input-index")"
  echo "$((n+1))" > "$work/input-index"
  case "$n" in 1) echo 3000 ;; 2) echo 41234 ;; 3) echo 192.168.10.30 ;; *) exit 99 ;; esac
}
SUBBOOST_ASSUME_YES=0
port_is_free() { [ "$1" = 41234 ]; }
detect_local_host() { return 1; }
configure_restored_local_access
grep -q '^APP_URL=http://192.168.10.30:41234$' "$ENV_FILE"
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("端口无效或已被占用");
    expect(r.stderr).toContain("无法自动获取");
  });

  it("verifies HTTPS using refreshed public DNS when local cache is stale", () => {
    const r = run(String.raw`
INSTALL_MODE=server TLS_MODE=auto HTTPS_DOMAIN=example.com
compose() { :; }
https_dns_preflight() { DNS_LOCAL_STALE=1; DNS_PUBLIC_ADDRESS=170.9.22.171; }
curl() {
  case "$*" in
    *example.com:443:127.0.0.1*) return 0 ;;
    *example.com:443:170.9.22.171*) printf 200 ;;
    *) return 99 ;;
  esac
}
https_start_and_check
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("公网 HTTPS 验证通过");
  });
});
