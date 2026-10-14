# 집 에이전트

항상 켜진 기기(cloudflared와 같은 호스트)에서 동작하는 Janitor 온프레미스 에이전트입니다.  
깨울 서버마다 설치하지 않습니다. WOL, 공인 IP 조회, HTTP 헬스 체크를 대신합니다.

코드 위치: [`agent/`](../agent/)

## 왜 분리하나

| 계층 | 담당 | 비밀값 예 |
| --- | --- | --- |
| Cloud Worker + Supabase | 로그인, 집/서버/서비스 CRUD, Slack 알림 | `SUPABASE_*`, `SLACK_WEBHOOK_URL` |
| 집 에이전트 | LAN에서만 가능한 작업 | `AGENT_TOKEN`, `HEALTHCHECK_TOKEN` |

대시보드와 Worker는 서버·서비스 **목록을 갖지 않는** 에이전트를 호출합니다.  
목록·기대 상태 코드는 Supabase에 두고, 에이전트에는 그때그때 URL/MAC만 넘깁니다. 더미 데이터는 넣지 않습니다.

## 구조

```text
agent/
  contract.json          # Worker 연동용 계약 스냅샷
  src/
    index.ts             # 서버 진입 + 선택적 job poller
    app.ts               # /v1/* 라우트 (safeEqual Bearer)
    auth.ts              # timing-safe Bearer AGENT_TOKEN
    poller.ts            # JANITOR_API_URL 있을 때 /api/agent/poll
    public-ip.ts
    health-check.ts
    wol/
      magic-packet.ts    # MAC magic packet (기본 브로드캐스트 255.255.255.255, 3회 송신)
```

기본 리슨: `0.0.0.0:3920`  
프로세스 프로브만 무인증: `GET /healthz`  
그 외 `/v1/*`는 Bearer 토큰 필수. 무인증 `POST /job` 없음 — 작업은 poller가 가져가며, 수동 실행은 `POST /v1/poll/now`(인증)만.

## 환경 변수

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `AGENT_TOKEN` | yes | Worker/대시보드가 보내는 Bearer 토큰 |
| `JANITOR_API_URL` | poll용 | Worker base URL. 있으면 job 큐를 폴링 |
| `AGENT_POLL_MS` | no | 폴링 간격(ms), 기본 `15000`, 최소 `3000` |
| `SPEEDTEST_PROVIDER` | no | `auto`(기본) · `fast` · `cloudflare` — Fast.com CDN 우선, 실패 시 Cloudflare |
| `SPEEDTEST_DURATION_MS` | no | 다운로드 측정 시간(ms), 기본 `12000` (3–60초) |
| `SPEEDTEST_CONNECTIONS` | no | 병렬 연결 수, 기본 `4` (1–8) |
| `SPEED_PROBE_BYTES` | no | 레거시 단일 샘플 상한(호환용) |
| `PORT` | no | 기본 `3920` |
| `HOST` | no | 기본 `0.0.0.0` |
| `CF_TUNNEL_HOSTNAME` | no | 상태 응답에 광고할 Tunnel 호스트명 |
| `HEALTHCHECK_TOKEN` | no | `useHealthToken: true`일 때 헬스 요청에 붙임 |
| `AGENT_ALLOW_REMOTE_UPDATE` | no | `true`면 대시보드 원격 업데이트(job) 허용 |
| `AGENT_DEPLOY_ON_UPDATE` | no | `true`면 업데이트 시 저장소 루트에서 `npm run deploy` (기본: remote update와 동일) |
| `CLOUDFLARE_API_TOKEN` | 배포 시 | Worker 배포용. 에이전트 호스트 env / pm2에 설정 |
| `PM2_APP_NAME` | 원격갱신 시 | pm2 프로세스 이름 (예: `ops-agent`) |
| `AGENT_REPO_DIR` | no | agent 패키지 디렉터리 (기본 cwd). git root는 자동 탐색해 deploy |

샘플: [`agent/.env.example`](../agent/.env.example).  
`.env`와 실제 비밀값은 git에 커밋하지 않습니다.

## 로컬 실행

```bash
cd agent
cp .env.example .env   # AGENT_TOKEN 설정
npm install
npm run typecheck
npm test
npm start
```

`npm start` / `npm run dev`는 기동 시 프로젝트 루트의 `.env`를 읽습니다.  
이미 셸에보낸 환경 변수가 있으면 그쪽이 우선입니다.

`.env` 예 (따옴표·`export` 없이 적어도 됩니다):

```bash
AGENT_TOKEN=여기에-긴-비밀값
PORT=3920
```

`AGENT_TOKEN is required`가 나오면:

1. `.env`가 **`agent/` 폴더 안**에 있는지 (`agent/.env`)
2. 내용이 `AGENT_TOKEN=값` 한 줄인지 (앞에 공백/한글 키 이름 없는지)
3. 임시로 `AGENT_TOKEN=값 npm start` 로도 뜨는지

개발 중 재시작이 필요하면 `npm run dev` (`tsx watch`).

스모크 예:

```bash
curl -sS http://127.0.0.1:3920/healthz
curl -sS -H "Authorization: Bearer $AGENT_TOKEN" http://127.0.0.1:3920/v1/status
```

## 현재 구현 범위

| 기능 | 상태 |
| --- | --- |
| MAC Wake-on-LAN | 동작 (UDP magic packet 브로드캐스트, 기본 3회) |
| 자동 스케줄 | tick마다 주기·마지막 시각을 보고 due인 것만 실행 (집 설정, **0=끔**). 수동 버튼도 그대로 동작 |
| 공인 IP | `ipify` → `ifconfig.me`. 기본 **2시간** (잘 안 바뀜) |
| HTTP 헬스 | 기본 **5분** `health_all` |
| Proxmox 동기화 | 기본 **15분** `pve_sync` |
| 속도 측정 | Fast.com 스타일. 기본 **1시간** (측정 비용↑) |
| 요청 로그 | 모든 HTTP·job을 `received` → `processing` → `complete`/`failed` 3단계로 stdout JSON (토큰 비출력) |
| Job poller (`JANITOR_API_URL`) | 동작 (`tick` 동시 실행 가드, 인증 poll/report) |
| 런타임 상태 보고 | 버전·hostname·pm2·uptime을 매 tick 보고, UI 자동 표시 |
| 원격 업데이트 · 배포 | `agent_update` → git pull → (opt) 루트 `npm run deploy` → agent npm → `pm2 restart` |

pm2 예시 (agent/ 에서):

```bash
npm install
pm2 delete janitor-agent 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
```

`tsx: command not found` 가 나면 `npm install` 후 위처럼 **ecosystem으로** 다시 띄우세요. (`pm2 start npm -- start` 비권장)

## 관련 문서

- [API 상세](./home-agent-api.md)
- [Tunnel 연동](./home-agent-tunnel.md)
