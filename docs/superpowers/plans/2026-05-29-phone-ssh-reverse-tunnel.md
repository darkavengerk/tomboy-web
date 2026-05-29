# 노트 → 역터널 → 폰 SSH 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 터미널 노트와 동일한 방식으로 `ssh://phone` 노트를 열면 폰(Termux)에 SSH 접속되도록, 폰→RPi autossh 역터널 + bridge 별칭 해석을 구축한다.

**Architecture:** 폰이 RPi로 상시 역방향 SSH 터널(`-R 127.0.0.1:18022:127.0.0.1:8022`)을 유지 → bridge(`Network=host`)가 고정 `localhost:18022`로 폰 sshd에 도달. bridge에 reMarkable 호스트맵과 동일한 별칭 맵(`sshHosts.ts`)을 추가해 `ssh://phone`을 `localhost:18022/termux`로 해석. 앱 코드 변경 없음.

**Tech Stack:** Node + ws (bridge, `node --test`), Termux openssh/autossh, Magisk `service.d`, Podman Quadlet.

설계 출처: `docs/superpowers/specs/2026-05-29-phone-ssh-reverse-tunnel-design.md`

---

### Task 1: bridge SSH 별칭 맵 (`sshHosts.ts`)

**Goal:** `ssh-hosts.json`(`{alias:{host,user?,port?}}`)을 로드하고, `SshTarget`의 host가 별칭이면 치환하는 순수 모듈을 추가한다.

**Files:**
- Create: `bridge/src/sshHosts.ts`
- Test: `bridge/src/sshHosts.test.ts`

**Acceptance Criteria:**
- [ ] 유효 파일 로드 시 `lookupSshHost('phone')`가 엔트리 반환
- [ ] 결측/undefined 경로 → 빈 테이블, throw 없음
- [ ] `applySshAlias({host:'phone'})` → `{target:{host:'localhost',port:18022,user:'termux'}, alias:'phone'}`
- [ ] 노트가 명시한 user/port는 별칭값보다 우선 보존
- [ ] 비별칭 host → 원본 그대로, `alias:null`

**Verify:** `cd bridge && node --test dist/sshHosts.test.js` → 모든 테스트 PASS (또는 `npm run build` 후 동일)

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `bridge/src/sshHosts.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSshHosts, lookupSshHost, applySshAlias } from './sshHosts.js';

function writeHosts(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'sshhosts-'));
	const path = join(dir, 'ssh-hosts.json');
	writeFileSync(path, JSON.stringify(obj), 'utf8');
	return path;
}

test('loads a valid alias', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	assert.deepEqual(lookupSshHost('phone'), { host: 'localhost', user: 'termux', port: 18022 });
});

test('missing file → empty table, no throw', () => {
	loadSshHosts('/nonexistent/ssh-hosts.json');
	assert.equal(lookupSshHost('phone'), null);
});

test('undefined path → empty table', () => {
	loadSshHosts(undefined);
	assert.equal(lookupSshHost('phone'), null);
});

test('entry without host is skipped', () => {
	const path = writeHosts({ bad: { user: 'x' }, phone: { host: 'localhost' } });
	loadSshHosts(path);
	assert.equal(lookupSshHost('bad'), null);
	assert.equal(lookupSshHost('phone')!.host, 'localhost');
});

test('applySshAlias resolves a bare alias target', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	const { target, alias } = applySshAlias({ host: 'phone' });
	assert.equal(alias, 'phone');
	assert.deepEqual(target, { host: 'localhost', port: 18022, user: 'termux' });
});

test('applySshAlias preserves note-specified user and port', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	const { target } = applySshAlias({ host: 'phone', user: 'me', port: 9999 });
	assert.deepEqual(target, { host: 'localhost', port: 9999, user: 'me' });
});

test('applySshAlias leaves non-alias targets untouched', () => {
	loadSshHosts(undefined);
	const { target, alias } = applySshAlias({ host: 'example.com', user: 'bob', port: 22 });
	assert.equal(alias, null);
	assert.deepEqual(target, { host: 'example.com', user: 'bob', port: 22 });
});
```

- [ ] **Step 2: 테스트 실패 확인** — Run: `cd bridge && npx tsc -p . && node --test dist/sshHosts.test.js` → FAIL (`sshHosts.js` 없음 / export 없음)

- [ ] **Step 3: 구현** — `bridge/src/sshHosts.ts` (구조는 `remarkableHosts.ts` 미러링)

```ts
import { readFileSync } from 'node:fs';
import type { SshTarget } from './pty.js';

export interface SshHostAlias {
	/** 브릿지에서 닿는 호스트 (역터널이면 'localhost'). */
	host: string;
	/** SSH 사용자. 미지정 시 SSH 호출 측 기본값. */
	user?: string;
	/** SSH 포트. 역터널 바인드 포트(예: 18022). */
	port?: number;
}

let table = new Map<string, SshHostAlias>();

export function loadSshHosts(path: string | undefined): void {
	table = new Map();
	if (!path) return;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			console.log(`[term-bridge] ssh-hosts file not found, aliases disabled: ${path}`);
		} else {
			console.error(`[term-bridge] failed to read ssh-hosts file ${path}:`, err);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error('[term-bridge] ssh-hosts file is not valid JSON:', err);
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[term-bridge] ssh-hosts file must be an object {alias: entry}');
		return;
	}
	for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = normalizeEntry(alias, value);
		// 별칭은 사용자 정의 키 — 소문자로 접지 않는다 (remarkableHosts 와 동일).
		if (entry) table.set(alias, entry);
	}
	console.log(`[term-bridge] loaded ${table.size} ssh alias(es) from ${path}`);
}

function normalizeEntry(alias: string, value: unknown): SshHostAlias | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		console.warn(`[term-bridge] ssh-hosts[${alias}] must be an object, skipped`);
		return null;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.host !== 'string' || !v.host.trim()) {
		console.warn(`[term-bridge] ssh-hosts[${alias}].host required, skipped`);
		return null;
	}
	const out: SshHostAlias = { host: v.host.trim() };
	if (typeof v.user === 'string' && v.user.trim()) out.user = v.user.trim();
	if (typeof v.port === 'number' && v.port >= 1 && v.port <= 65535) out.port = Math.floor(v.port);
	return out;
}

export function lookupSshHost(alias: string): SshHostAlias | null {
	return table.get(alias) ?? null;
}

/**
 * 타깃 host가 등록된 별칭이면 alias 엔트리로 치환한다. 노트가 명시한
 * user/port는 별칭값보다 우선 보존한다(ssh://me@phone:9999 → me/9999 유지).
 * 별칭이 아니면 원본을 그대로 반환하고 alias=null.
 */
export function applySshAlias(target: SshTarget): { target: SshTarget; alias: string | null } {
	const entry = lookupSshHost(target.host);
	if (!entry) return { target, alias: null };
	return {
		target: {
			host: entry.host,
			port: target.port ?? entry.port,
			user: target.user ?? entry.user
		},
		alias: target.host
	};
}
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `cd bridge && npx tsc -p . && node --test dist/sshHosts.test.js` → 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/sshHosts.ts bridge/src/sshHosts.test.ts
git commit -m "feat(bridge): ssh-hosts 별칭 맵 (sshHosts.ts) + 테스트"
```

---

### Task 2: server.ts에 별칭 해석 + 터널 끊김 친절 에러 와이어링

**Goal:** bridge 부팅 시 `BRIDGE_SSH_HOSTS_FILE`을 로드하고, connect 처리에서 `applySshAlias`로 타깃을 해석하며, 별칭 타깃이 도달 불가면 한국어 친절 에러를 보낸다.

**Files:**
- Modify: `bridge/src/server.ts` (import + 부팅 로드 + connect 핸들러 + startSession)

**Acceptance Criteria:**
- [ ] `npx tsc -p .` 타입 통과, 기존 `node --test` 스위트 전부 PASS (회귀 없음)
- [ ] `ssh://phone` connect 시 `localhost:18022`로 ssh 시도 (로그에 `target=termux@localhost:18022`)
- [ ] 터널 미연결 시 `'phone' 터널이 연결되어 있지 않습니다 …` 에러 송신, raw "connection refused" 미노출
- [ ] 비별칭 타깃 동작 불변(회귀 없음)

**Verify:** `cd bridge && npx tsc -p . && node --test` → 전체 PASS. (별칭/친절에러 경로는 Task 4·5 E2E로 검증.)

**Steps:**

- [ ] **Step 1: import 추가** — `bridge/src/server.ts` 상단 import 블록(`loadRemarkableHosts` 임포트 아래)에 추가:

```ts
import { loadSshHosts, applySshAlias } from './sshHosts.js';
```

- [ ] **Step 2: 부팅 로드** — `const REMARKABLE_HOSTS_FILE = ...` 아래(env 상수 구역)에 추가하고, `loadRemarkableHosts(...)` 호출 근처에 로더 호출 추가:

```ts
const SSH_HOSTS_FILE = process.env.BRIDGE_SSH_HOSTS_FILE;
```

그리고 로더 호출부(`loadHostsFile(HOSTS_FILE);`가 있는 줄들 옆):

```ts
loadSshHosts(SSH_HOSTS_FILE);
```

- [ ] **Step 3: connect 핸들러에서 별칭 해석** — `const target = parseSshTarget(String(msg.target ?? ''));` 블록을 아래로 교체. 별칭 여부를 closure 변수에 저장해 startSession이 친절 에러에 쓰게 한다. ws 연결 closure 상단(`let pty ...`, `let sessionTarget ...` 등이 선언된 곳)에 `let connectAlias: string | null = null;`를 추가하고, 핸들러를 다음과 같이 수정:

```ts
			const parsed = parseSshTarget(String(msg.target ?? ''));
			if (!parsed) {
				send({ type: 'error', message: 'invalid target' });
				ws.close(1008, 'invalid target');
				return;
			}
			const resolved = applySshAlias(parsed);
			const target = resolved.target;
			connectAlias = resolved.alias;
```

(이후 `void startSpectator(target, session);` / `void startSession(target, cols, rows);`는 그대로 — 이미 `target` 변수를 받음.)

- [ ] **Step 4: startSession에 도달성 probe + 친절 에러** — `startSession` 안, WoL 블록 직후·`spawnForTarget` 직전에 추가:

```ts
		// 별칭(역터널) 타깃은 WoL이 없으므로 별도 도달성 체크 — 터널이
		// 안 떠 있으면 raw connection-refused 대신 한국어 안내를 보낸다.
		if (connectAlias && !isLocalTarget(target)) {
			const reachable = await probePort(target.host, target.port ?? 22, {
				timeoutMs: 1000,
				signal: abortCtrl.signal
			});
			if (!reachable) {
				if (!abortCtrl.signal.aborted) {
					send({
						type: 'error',
						message: `'${connectAlias}' 터널이 연결되어 있지 않습니다 (폰이 깨어 있고 네트워크에 연결됐는지 확인하세요)`
					});
					try { ws.close(1011, 'tunnel down'); } catch { /* ignore */ }
				}
				return;
			}
		}
```

(`probePort`는 이미 `./wol.js`에서 import됨 — 추가 import 불필요.)

- [ ] **Step 5: 빌드 + 전체 테스트** — Run: `cd bridge && npx tsc -p . && node --test` → 타입 통과 + 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/server.ts
git commit -m "feat(bridge): ssh 별칭 해석 + 역터널 끊김 친절 에러"
```

---

### Task 3: Quadlet 마운트 + ssh-hosts.json 예시

**Goal:** bridge 컨테이너가 `ssh-hosts.json`을 RO로 마운트하고 `BRIDGE_SSH_HOSTS_FILE`을 받도록 Quadlet 유닛을 수정하고, 예시 config를 문서화한다.

**Files:**
- Modify: `bridge/deploy/term-bridge.container` (Volume + Environment 추가, 헤더 주석에 셋업 단계 추가)

**Acceptance Criteria:**
- [ ] `.container`에 `ssh-hosts.json` RO 마운트 + `BRIDGE_SSH_HOSTS_FILE` env 존재
- [ ] 헤더 주석에 `~/.config/term-bridge/ssh-hosts.json` 작성 단계 + `{phone:{host:localhost,port:18022,user:termux}}` 예시 포함
- [ ] 파일 결측 시 별칭 비활성(부팅 거부 아님)임을 주석에 명시

**Verify:** `grep -n "ssh-hosts" bridge/deploy/term-bridge.container` → Volume·Environment·예시 라인 출력

**Steps:**

- [ ] **Step 1: Volume + Environment 추가** — `[Container]` 섹션의 reMarkable Volume/Environment 쌍 아래에 추가:

```ini
# SSH 별칭 맵 — read-only, alias → {host,user?,port?}. 노트의 ssh://<별칭>
# 을 실제 접속 좌표로 치환한다(예: 역터널 phone → localhost:18022). 파일이
# 없거나 유효 항목이 없으면 별칭 비활성(부팅은 정상, 일반 ssh:// 만 동작).
Volume=%h/.config/term-bridge/ssh-hosts.json:/etc/term-bridge/ssh-hosts.json:ro,z
Environment=BRIDGE_SSH_HOSTS_FILE=/etc/term-bridge/ssh-hosts.json
```

- [ ] **Step 2: 헤더 주석에 셋업 단계 추가** — reMarkable 단계(5번) 뒤에 새 단계 주석 삽입:

```
#   5b. (선택) 폰/원격 역터널 별칭을 쓰면 ~/.config/term-bridge/ssh-hosts.json
#       을 만든다. 별칭 → 접속 좌표:
#         { "phone": { "host": "localhost", "port": 18022, "user": "termux" } }
#       노트의 ssh://<별칭> 과 매칭된다. 파일이 없으면 별칭 비활성(부팅 정상).
#       remarkable.json 과 마찬가지로 podman이 결측 source를 디렉토리로
#       만들어 마운트를 깨뜨리므로, 유닛 시작 前에 파일을 먼저 만들 것.
```

- [ ] **Step 3: 커밋**

```bash
git add bridge/deploy/term-bridge.container
git commit -m "deploy(bridge): ssh-hosts.json Quadlet 마운트 + 셋업 주석"
```

---

### Task 4: 폰+RPi 역터널 1회 셋업 + `ssh://phone` 노트 접속 검증 (런북)

**Goal:** 폰 sshd + 키 + autossh 역터널을 띄우고, RPi에 포워딩 전용 tunnel 유저를 만들고, bridge에 ssh-hosts.json을 배치해 `ssh://phone` 노트로 셸 진입까지 한 번 수동으로 성공시킨다.

**Files:** (코드 아님 — 디바이스/서버 설정)
- 폰 Termux: `~/.ssh/tunnel_key`(키쌍), sshd 설정
- RPi: `~tunnel/.ssh/authorized_keys`, bridge 호스트 `~/.ssh/known_hosts`, `~/.config/term-bridge/ssh-hosts.json`

**Acceptance Criteria:**
- [ ] 폰 autossh 기동 후 RPi에서 `ss -tlnp | grep 18022` → `127.0.0.1:18022` LISTEN 확인
- [ ] RPi 호스트에서 `ssh -p 18022 termux@localhost` → 폰 Termux 셸 진입(키 인증, 비번 프롬프트 없음)
- [ ] 노트 본문 `폰\nssh://phone\nbridge: wss://term.<도메인>/ws` → 앱에서 열면 폰 셸 등장

**Verify:** 위 세 가지 수동 확인. RPi: `ssh -p 18022 termux@localhost 'getprop ro.product.model'` → `LG-...`/`joan` 류 출력.

**Steps:**

- [ ] **Step 1: 폰 Termux 패키지 + sshd** (adb 경유 또는 폰에서 직접)

```bash
# 폰 Termux 안에서
pkg install -y openssh autossh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/tunnel_key -N ''   # 폰→RPi 터널용 키
# Termux sshd 는 키 인증 기본 지원. 키 등록은 Step 3.
sshd            # 8022 기동 (이미 떠 있으면 무시)
whoami          # 로그인 유저명 확인 — Termux는 임의 username 허용, 'termux' 로 통일
```

- [ ] **Step 2: RPi에 tunnel 유저 + 제한 키** (RPi에 ssh 접속해서)

```bash
sudo useradd -m -s /usr/sbin/nologin tunnel 2>/dev/null || true
sudo -u tunnel mkdir -p /home/tunnel/.ssh && sudo chmod 700 /home/tunnel/.ssh
# 폰의 ~/.ssh/tunnel_key.pub 내용을 가져와 아래 KEY 자리에 붙인다.
echo 'restrict,port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding <KEY>' \
  | sudo tee -a /home/tunnel/.ssh/authorized_keys
sudo chown -R tunnel:tunnel /home/tunnel/.ssh
sudo chmod 600 /home/tunnel/.ssh/authorized_keys
```

- [ ] **Step 3: bridge 호스트 키를 폰에 등록** (RPi에서 폰으로 — 키 인증용)

```bash
# bridge 컨테이너가 마운트하는 Pi 유저 ~/.ssh 의 공개키를 폰에 등록.
# (없으면 ssh-keygen -t ed25519 로 생성) 폰이 LAN에 보일 때 1회:
ssh-copy-id -i ~/.ssh/id_ed25519.pub -p 8022 termux@192.168.219.113
# 확인: ssh -p 8022 termux@192.168.219.113 'echo ok'  → 비번 없이 ok
```

- [ ] **Step 4: 폰에서 autossh 역터널 수동 기동**

```bash
# 폰 Termux 안에서
autossh -M 0 -N \
  -R 127.0.0.1:18022:127.0.0.1:8022 \
  -i $HOME/.ssh/tunnel_key \
  -p 22 tunnel@umayloveme.duckdns.org \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new &
```

- [ ] **Step 5: RPi에서 터널 + known_hosts 선등록**

```bash
ss -tlnp | grep 18022                     # 127.0.0.1:18022 LISTEN 확인
ssh-keyscan -p 18022 localhost >> ~/.ssh/known_hosts   # RO 마운트 대비 선등록
ssh -p 18022 termux@localhost 'echo tunnel-ok'         # 셸 도달 확인
```

- [ ] **Step 6: bridge ssh-hosts.json 배치 + 재시작**

```bash
# RPi의 bridge 유저로
mkdir -p ~/.config/term-bridge
cat > ~/.config/term-bridge/ssh-hosts.json <<'JSON'
{ "phone": { "host": "localhost", "port": 18022, "user": "termux" } }
JSON
# Task 1~3 이미지가 빌드/배포돼 있어야 함:
cd <bridge-checkout> && podman build -t term-bridge:latest .
systemctl --user restart term-bridge
journalctl --user -u term-bridge -n 20 | grep "ssh alias"   # "loaded 1 ssh alias(es)" 확인
```

- [ ] **Step 7: 노트 작성 + 접속 검증** — 앱에서 새 노트:

```
폰
ssh://phone
bridge: wss://term.<도메인>/ws
```

열면 폰 Termux 셸이 등장해야 한다. (기본 bridge면 `bridge:` 줄 생략 가능.)

---

### Task 5: Magisk service.d 부팅 자동 기동 + 재부팅 E2E

**Goal:** 폰 재부팅 후 사람 개입 없이 sshd + autossh가 자동 기동되어 `ssh://phone` 노트가 그대로 동작함을 보장한다.

**Files:**
- 폰: `/data/adb/service.d/tomboy-tunnel.sh` (root, 부팅 스크립트)

**Acceptance Criteria:**
- [ ] `/data/adb/service.d/tomboy-tunnel.sh` 존재 + 실행권한(755)
- [ ] 폰 재부팅 후(잠금 해제 상태) 수동 개입 없이 RPi `ss -tlnp | grep 18022`가 LISTEN
- [ ] 재부팅 후 `ssh://phone` 노트가 셸 진입(Task 4 검증 재현)

**Verify:** 폰 `reboot` → 폰 잠금 해제 → 60초 대기 → RPi에서 `ssh -p 18022 termux@localhost 'echo reboot-ok'` → `reboot-ok`. 이것이 본 기능의 **최우선 수용 기준**이다.

**Steps:**

- [ ] **Step 1: Termux UID 확인** (root shell)

```bash
v30su 'stat -c %u /data/data/com.termux/files/home'   # 예: 10123
```

- [ ] **Step 2: service.d 스크립트 작성** — `<TERMUX_UID>`를 Step 1 값으로 치환. (정확한 Termux 기동 incantation은 폰마다 달라 실기로 한 줄씩 검증 — `su -lp` 가 안 먹으면 `su <uid> -c` / `run-as` 대안 시도.)

```sh
#!/system/bin/sh
# tomboy 역터널 부팅 기동 (Magisk service.d, root)
until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 2; done
sleep 30   # WiFi/복호화 안정화
su -lp <TERMUX_UID> -c '
  export PREFIX=/data/data/com.termux/files/usr
  export HOME=/data/data/com.termux/files/home
  export PATH=$PREFIX/bin:$PATH
  export LD_LIBRARY_PATH=$PREFIX/lib
  pgrep -x sshd >/dev/null || sshd
  pgrep -f "autossh.*18022" >/dev/null || \
    autossh -M 0 -N -R 127.0.0.1:18022:127.0.0.1:8022 \
      -i $HOME/.ssh/tunnel_key -p 22 tunnel@umayloveme.duckdns.org \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new &
'
```

- [ ] **Step 3: 폰에 설치 + 권한**

```bash
v30u push tomboy-tunnel.sh /sdcard/Download/
v30su 'cp /sdcard/Download/tomboy-tunnel.sh /data/adb/service.d/tomboy-tunnel.sh && chmod 755 /data/adb/service.d/tomboy-tunnel.sh && ls -l /data/adb/service.d/tomboy-tunnel.sh'
```

- [ ] **Step 4: 스크립트 즉시 1회 실행 검증** (재부팅 전 로직 점검)

```bash
v30su 'sh /data/adb/service.d/tomboy-tunnel.sh &' ; sleep 35
# RPi에서
ss -tlnp | grep 18022     # LISTEN 확인
```

- [ ] **Step 5: 재부팅 E2E** (최우선 수용 기준)

```bash
v30u reboot
# 폰 부팅 + 잠금 해제 대기 후 (~60s)
# RPi에서:
ssh -p 18022 termux@localhost 'echo reboot-ok'   # → reboot-ok
# 앱에서 ssh://phone 노트 열어 셸 진입 재현
```

- [ ] **Step 6: 런북 메모를 워크스페이스 CLAUDE.md/메모리에 반영** (선택, 운영 지속성)

폰 셋업 절차를 `/var/home/umayloveme/workspace/LG/CLAUDE.md` 또는 메모리에 한 줄 추가해 재부팅 복구 무개입을 기록.

---

## 의존성

- Task 2 ← Task 1 (별칭 모듈)
- Task 3 ← Task 2 (env 소비)
- Task 4 ← Task 3 (ssh-hosts.json 마운트 + bridge 재시작 필요)
- Task 5 ← Task 4 (수동 터널이 먼저 검증돼야 자동화 의미)

## 자체 점검 메모

- 스펙 §5.3(코드)=Task 1~3, §5.1/5.2/6(런북)=Task 4~5, §7 실패모드=Task 2 친절에러 + Task 5 재부팅, §9 테스트=Task 1 단위 + Task 4/5 E2E. 누락 없음.
- 포트 18022는 코드가 아니라 config(ssh-hosts.json)·런북에만 등장 — bridge는 범용 별칭 해석만.
- 앱 코드 변경 0 (스펙 §5.3 확인) — 플랜에 app/ 태스크 없음이 정상.
