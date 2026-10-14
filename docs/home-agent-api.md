# 집 에이전트 API

기준 계약: [`agent/contract.json`](../agent/contract.json)  
Base URL (집 안): `http://<host>:3920`  
Base URL (외부): `https://$CF_TUNNEL_HOSTNAME`

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

에이전트 연결·capability 확인. 대시보드의 “에이전트 연결됨”에 대응합니다.

```json
{
  "ok": true,
  "service": "janitor-home-agent",
  "tunnelHostname": "agent.example.com",
  "capabilities": {
    "wakeManual": true,
    "publicIp": true,
    "httpCheck": true
  }
}
```

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
| `useHealthToken` | `false` | `true`면 `HEALTHCHECK_TOKEN`을 Bearer로 붙임 |

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

---

## `POST /v1/poll/now`

`JANITOR_API_URL`이 설정된 에이전트에서 폴링 tick을 한 번 즉시 실행합니다.  
무인증 `POST /job`은 없습니다. Bearer `AGENT_TOKEN` 필수. 이미 tick이 돌고 있으면 가드로 스킵합니다.

| 결과 | HTTP | body |
| --- | --- | --- |
| 성공 | `200` | `{ "ok": true }` |
| `JANITOR_API_URL` 없음 | `400` | `{ "error": "JANITOR_API_URL is not configured" }` |
| poll/report 실패 | `502` | `{ "error": "..." }` |

---

## Worker 호출 요약

```http
GET  https://$CF_TUNNEL_HOSTNAME/v1/status
GET  https://$CF_TUNNEL_HOSTNAME/v1/network/public-ip
POST https://$CF_TUNNEL_HOSTNAME/v1/wake
POST https://$CF_TUNNEL_HOSTNAME/v1/checks/http
POST https://$CF_TUNNEL_HOSTNAME/v1/poll/now
Authorization: Bearer $AGENT_TOKEN
Content-Type: application/json
```

작업 큐는 에이전트가 Worker `GET /api/agent/poll`로 가져갑니다 (토큰 해시 검증).  
서버·서비스 목록은 에이전트에 캐시하지 마세요. Supabase가 source of truth입니다.
