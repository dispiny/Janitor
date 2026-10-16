# 집 에이전트 API

기준 계약: [`agent/contract.json`](../agent/contract.json)  
Base URL (집 안): `http://<host>:3920`  
Base URL (선택, Tunnel): `https://$CF_TUNNEL_HOSTNAME`

> 이 `/v1/*` API는 **로컬/LAN(또는 선택적 Tunnel)에서의 수동 호출용**입니다.  
> Cloud Worker는 이 API를 호출하지 않습니다. 대시보드 작업은 에이전트가 Worker를 폴링해서 가져갑니다 — [폴링 모델](#worker-연동-폴링)

## 인증

`/v1/*` 요청:

```http
Authorization: Bearer <AGENT_TOKEN>
```

토큰이 없거나 틀리면 `401`과 `{ "error": "unauthorized" }`를 반환합니다.  
비교는 timing-safe 합니다.

`GET /healthz`만 인증 없이 사용할 수 있습니다 (프로세스/컨테이너 프로브용).

---

## `GET /healthz`

프로세스 생존 확인.

```json
{ "ok": true }
```

---

## `GET /v1/status`

에이전트 연결·capability·런타임 확인. (대시보드의 “에이전트 연결됨”은 이 API가 아니라 폴링 시각 `agent_last_seen_at` 기준입니다.)

```json
{
  "ok": true,
  "service": "janitor-home-agent",
  "tunnelHostname": "agent.example.com",
  "runtime": {
    "version": "0.2.0",
    "node": "v22.17.0",
    "hostname": "nas",
    "uptimeSec": 3600,
    "pollMs": 15000,
    "pm2": true,
    "pm2Name": "janitor-agent",
    "remoteUpdate": false,
    "deployOnUpdate": false,
    "reportedAt": "2026-10-17T00:00:00.000Z"
  },
  "capabilities": {
    "wakeManual": true,
    "publicIp": true,
    "httpCheck": true,
    "remoteUpdate": false
  }
}
```

`runtime`에는 위 외에 `platform`, `arch`, `pid`, `cwd`도 있습니다 (매 tick `agentStatus`로도 보고).

Wake는 MAC magic packet만 지원합니다 (`wakeManual`).

---

## `GET /v1/network/public-ip`

공인 IP를 조회합니다.

```json
{
  "ip": "203.0.113.42",
  "checkedAt": "2026-10-11T18:00:00.000Z",
  "source": "ipify"
}
```

응답 본문이 IPv4/IPv6 형태가 아니면 해당 소스는 실패로 처리합니다.  
모든 소스가 실패하면 `502`와 `{ "error": "public_ip_failed", "message": "ipify ...; ifconfig.me ..." }`처럼 원인 목록을 담습니다.

---

## `POST /v1/wake`

서버를 MAC magic packet으로 깨웁니다. (`mode`는 생략 가능, `manual`만 허용)

```json
{
  "mode": "manual",
  "mac": "02:00:00:00:00:10",
  "broadcast": "255.255.255.255",
  "port": 9
}
```

| 필드 | 기본값 | 설명 |
| --- | --- | --- |
| `mac` | (필수) | `AA:BB:…`, `AA-BB-…`(Windows), 또는 12자리 hex |
| `broadcast` | `255.255.255.255` | UDP 브로드캐스트. 서브넷이 다르면 예: `192.168.219.255` |
| `port` | `9` | WOL 포트 |

성공 예:

```json
{
  "ok": true,
  "mode": "manual",
  "mac": "02:00:00:00:00:10",
  "broadcast": "255.255.255.255",
  "port": 9,
  "bytes": 102,
  "sent": 3
}
```

잘못된 MAC/body → `400`. 패킷은 같은 내용으로 3번 보냅니다.  
`200`은 **패킷을 보냈다**는 뜻이지 서버가 켜졌다는 뜻이 아닙니다.

대시보드 `wake` job은 결과에 `state: "sent"`를 남기고, 서버에 `manage_url`이 있으면 약 3분 동안 다음 tick마다 그 URL로 GET을 보내 **어떤 HTTP 응답이든 오면** `is_on=true`를 보고합니다. 3분 안에 응답이 없으면 경고 로그(`poller.wake.unverified`)만 남기고 상태는 바꾸지 않습니다. `manage_url`이 없으면 확인하지 않습니다(`verify: "unavailable"`).

---

## `POST /v1/checks/http`

서비스 헬스 URL을 에이전트 LAN/Tunnel 경로에서 확인합니다.

```json
{
  "url": "https://ha.home/api/",
  "expectStatus": 200,
  "timeoutMs": 8000,
  "useHealthToken": false
}
```

| 필드 | 기본값 | 설명 |
| --- | --- | --- |
| `url` | (필수) | 절대 URL |
| `expectStatus` | `200` | 기대 HTTP 상태 |
| `timeoutMs` | `8000` | 200–30000 |
| `useHealthToken` | `false` | `true`면 `HEALTHCHECK_TOKEN`을 Bearer로 붙임 (대시보드 자동 체크는 서비스별 `use_health_token`) |

응답 body는 항상 JSON이며, HTTP 상태로도 성공/실패를 구분합니다.

| 결과 | HTTP | body |
| --- | --- | --- |
| 기대 상태와 일치 | `200` | `{ "ok": true, "status", "expectStatus", "ms", "url" }` |
| 기대 불일치·타임아웃·네트워크 실패 | `502` | `{ "ok": false, ... , "error"? }` |

```json
{
  "url": "https://ha.home/api/",
  "ok": true,
  "status": 200,
  "expectStatus": 200,
  "ms": 42
}
```

`useHealthToken: true`인데 env가 없으면 `400`.  
리다이렉트는 따라가지 않습니다(3xx 상태 그대로). 링크로컬·메타데이터 주소(169.254.0.0/16, `0.0.0.0/8`, `fe80::/10`, `[::ffff:169.254.169.254]` 같은 IPv4-mapped 형태)와 DNS로 그런 주소가 나오는 호스트명(예: `169.254.169.254.nip.io`)은 `400 url_not_allowed`/실패로 거부합니다. 사설 LAN·loopback은 허용.

---

## `POST /v1/poll/now`

`JANITOR_API_URL`이 설정된 에이전트에서 폴링 tick을 한 번 즉시 실행합니다.  
무인증 `POST /job`은 없습니다. Bearer `AGENT_TOKEN` 필수. 이미 tick이 돌고 있으면 새로 실행하지 않고 그 사실을 알려 줍니다.

| 결과 | HTTP | body |
| --- | --- | --- |
| 실행함 | `200` | `{ "ok": true, "started": true }` |
| 이미 실행 중 (아무것도 안 함) | `200` | `{ "ok": true, "started": false, "reason": "already_running" }` |
| `JANITOR_API_URL` 없음 | `400` | `{ "error": "JANITOR_API_URL is not configured" }` |
| poll/report 실패 | `502` | `{ "error": "..." }` |

---

## Worker 연동 (폴링)

Worker → 에이전트 방향 호출은 없습니다. 에이전트가 주기적으로 Worker를 부릅니다.

```http
GET  $JANITOR_API_URL/api/agent/poll     # jobs · servers · services(use_health_token 포함) · secrets
POST $JANITOR_API_URL/api/agent/report   # 결과 보고
Authorization: Bearer $AGENT_TOKEN
```

- 요청마다 30초 타임아웃. 연속 실패 시 폴링 간격을 2배씩 늘려 최대 5분, 성공하면 `AGENT_POLL_MS`로 복귀
- 실행 순서: `wake` 먼저 → 나머지(큐 순서) → `agent_update` 마지막. `agent_update`가 있는 tick에서는 자동 스케줄 작업을 건너뜀
- 헬스 체크는 최대 4개 동시
- report의 `jobs[]`는 uuid id + `done`/`error`만 (자동 스케줄 `sched-*`는 보고하지 않음)
- `speed`는 측정이 성공했을 때만 포함. 업로드 실패 시 `up_mbps: null`
- Proxmox: 노드 목록 조회 자체가 실패한 연동은 `guestSyncServerIds`·`pveNodes`에서 빠짐(아무것도 지우지 않음). 노드별 게스트 조회 실패는 `guestSyncFailedNodes: { "<server_id>": ["node"] }`로 보내 그 노드 게스트는 유지

서버·서비스 목록은 에이전트에 캐시하지 마세요. Supabase가 source of truth입니다.
