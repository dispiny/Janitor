# 집 에이전트

항상 켜진 기기에서 동작하는 Janitor 온프레미스 에이전트입니다 (Tunnel은 선택 사항).  
깨울 서버마다 설치하지 않습니다. WOL, 공인 IP 조회, HTTP 헬스 체크를 대신합니다.

코드 위치: [`agent/`](../agent/)

## 왜 분리하나

| 계층 | 담당 | 비밀값 예 |
| --- | --- | --- |
| Cloud Worker + Supabase | 로그인, 집/서버/서비스 CRUD, Slack 알림 | `SUPABASE_*`, `SLACK_WEBHOOK_URL` |
| 집 에이전트 | LAN에서만 가능한 작업 | `AGENT_TOKEN`, `HEALTHCHECK_TOKEN` |

Worker는 에이전트를 **호출하지 않습니다.** 에이전트가 `JANITOR_API_URL`을 폴링해 작업·서버·서비스 목록을 그때그때 받아 가고(`/api/agent/poll`), 결과를 보고합니다(`/api/agent/report`).  
그래서 집에 인바운드 포트나 Tunnel이 없어도 됩니다. 목록·기대 상태 코드는 Supabase에 두고 에이전트는 캐시하지 않습니다. 더미 데이터는 넣지 않습니다.  
`/v1/*` HTTP API는 로컬/LAN(또는 선택적 Tunnel)에서의 수동 호출용입니다 — [Tunnel 문서](./home-agent-tunnel.md).

## 구조

```text
agent/
  contract.json          # Worker 연동용 계약 스냅샷
  src/
    index.ts             # 서버 진입 + 선택적 job poller
    app.ts               # /v1/* 라우트 (safeEqual Bearer)
    auth.ts              # timing-safe Bearer AGENT_TOKEN
    poller.ts            # JANITOR_API_URL 있을 때 /api/agent/poll → 작업 → /api/agent/report
    schedule.ts          # 자동 스케줄(due 판단, 로컬 시도 기록, 실패 백오프)
    self-update.ts       # agent_update (git pull → npm ci → 실패 시 롤백)
    pve-sync.ts          # Proxmox API 게스트 동기화
    url-guard.ts         # 헬스/PVE URL SSRF 가드 (+DNS 해석 검사)
    speedtest.ts
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
| `AGENT_TOKEN` | yes | Worker 폴링(`/api/agent/*`)과 로컬 `/v1/*`에 쓰는 Bearer 토큰 |
| `JANITOR_API_URL` | poll용 | Worker base URL. 있으면 job 큐를 폴링 |
| `AGENT_POLL_MS` | no | 폴링 간격(ms), 기본 `15000`, 최소 `3000`, 최대 `300000`(넘으면 300000으로 맞춤 — Worker가 10분 무응답을 오프라인으로 봄) |
| `SPEEDTEST_PROVIDER` | no | `auto`(기본) · `fast` · `cloudflare` — Fast.com CDN 우선, 실패 시 Cloudflare |
| `SPEEDTEST_DURATION_MS` | no | 다운로드 측정 시간(ms), 기본 `12000` (3–60초) |
| `SPEEDTEST_CONNECTIONS` | no | 병렬 연결 수, 기본 `4` (1–8) |
| `SPEED_PROBE_BYTES` | no | 레거시 단일 샘플 상한(호환용) |
| `PORT` | no | 기본 `3920` |
| `HOST` | no | 기본 `0.0.0.0` |
| `CF_TUNNEL_HOSTNAME` | no | 상태 응답에 표시할 Tunnel 호스트명 (Worker는 이 주소로 호출하지 않음) |
| `HEALTHCHECK_TOKEN` | no | 서비스 설정에서 **헬스 토큰 사용**(`services.use_health_token = true`)을 켠 서비스, 또는 `/v1/checks/http`의 `useHealthToken: true`에만 Bearer로 붙임. 나머지 서비스에는 보내지 않음 |
| `PVE_TLS_INSECURE` | no | `true`면 Proxmox API TLS 검증 생략(자체 서명). **권장은 `NODE_EXTRA_CA_CERTS`** |
| `NODE_EXTRA_CA_CERTS` | no | Node 표준. PVE CA 파일 경로(PVE 호스트의 `/etc/pve/pve-root-ca.pem` 복사본). 검증을 유지한 채 자체 서명 인증서 신뢰 |
| `AGENT_ALLOW_REMOTE_UPDATE` | no | `true`면 대시보드 원격 업데이트(job) 허용 |
| `AGENT_UPDATE_REQUIRE_SIGNED` | no | `true`면 pull한 커밋을 `git verify-commit`으로 검증, 실패 시 이전 커밋으로 되돌리고 중단 (호스트에 서명 키 신뢰 설정 필요) |
| `AGENT_DEPLOY_ON_UPDATE` | no | `true`면 업데이트 시 저장소 루트에서 `npm run deploy` (기본: remote update와 동일) |
| `CLOUDFLARE_API_TOKEN` | 배포 시 | Worker 배포용. 에이전트 호스트 env / pm2에 설정 |
| `PM2_APP_NAME` | 원격갱신 시 | pm2 프로세스 이름. `ecosystem.config.cjs` 기본값 `janitor-agent`와 같아야 함 |
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

`npm start` / `npm run dev`는 기동 시 `agent/.env`를 읽습니다.  
이미 셸에서 export한 환경 변수가 있으면 그쪽이 우선입니다.

`.env` 예 (따옴표·`export` 없이 적어도 됩니다):

```bash
AGENT_TOKEN=여기에-긴-비밀값
PORT=3920
```

`AGENT_TOKEN is required`가 나오면:

1. `.env`가 **`agent/` 폴더 안**에 있는지 (`agent/.env`)
2. 내용이 `AGENT_TOKEN=값` 한 줄인지 (앞에 공백/한글 키 이름 없는지)
3. 임시로 `AGENT_TOKEN=값 npm start` 로도 뜨는지

개발 중에는 `npm run dev` (`tsx watch src/index.ts`) — 파일을 고치면 자동 재시작합니다.

스모크 예:

```bash
curl -sS http://127.0.0.1:3920/healthz
curl -sS -H "Authorization: Bearer $AGENT_TOKEN" http://127.0.0.1:3920/v1/status
```

## 현재 구현 범위

| 기능 | 상태 |
| --- | --- |
| MAC Wake-on-LAN | 동작 (UDP magic packet 브로드캐스트, 기본 3회). 결과는 `sent`. `manage_url`이 있으면 ~3분 동안 다음 tick마다 접속을 확인해 응답이 오면 `is_on=true` 보고, 시간 초과는 경고 로그만 |
| 자동 스케줄 | tick마다 주기·마지막 시각을 보고 due인 것만 실행 (집 설정, **0=끔**). 마지막 시각 = max(서버 기록, 에이전트 메모리의 마지막 시도) — 보고 실패나 게스트 0개로 서버 시각이 비어도 매 tick 재실행하지 않음. 같은 종류가 연속 실패하면 주기 ×2, ×4(최대)로 백오프. 수동 버튼도 그대로 동작 |
| 공인 IP | `ipify` → `ifconfig.me`. 기본 **2시간** (잘 안 바뀜) |
| HTTP 헬스 | 기본 **5분** `health_all`, 최대 4개 동시. 응답 본문은 읽지 않고 취소 |
| Proxmox 동기화 | 기본 **15분** `pve_sync`. 노드를 비운 API 연동이면 `/nodes`로 찾은 노드를 서버로 등록·갱신·정리 (`pveNodes`). 노드 목록 실패 시 그 연동은 보고에서 제외(삭제 없음), 노드별 게스트 조회 실패는 `guestSyncFailedNodes`로 보내 해당 노드 게스트 유지. 리다이렉트 미추종(토큰 헤더 보호), 요청마다 15초 타임아웃 |
| 속도 측정 | Fast.com 스타일. 기본 **1시간** (측정 비용↑). 측정 실패 시 job `error` + 보고에 `speed` 없음, 업로드만 실패하면 `up_mbps: null` |
| 요청 로그 | 모든 HTTP·job을 `received` → `processing` → `complete`/`failed` 3단계로 stdout JSON (토큰 비출력) |
| 웹 로그 | 폴링 시 구조화 이벤트 링버퍼를 `agent_report`로 올려 콘솔 **로그** 탭에 표시 (최근 100건) |
| Job poller (`JANITOR_API_URL`) | 동작 (`tick` 동시 실행 가드, 인증 poll/report, 30초 타임아웃, 실패 시 최대 5분 백오프) |
| 런타임 상태 보고 | 버전·hostname·pm2·uptime을 매 tick 보고, UI 자동 표시 |
| 원격 업데이트 · 배포 | `agent_update` → git pull → (opt) 서명 검증 → (opt) 루트 `npm run deploy` → agent `npm ci` → **report 전송 후** `pm2 restart`. Worker 배포가 성공하면 Slack 성공 알림. 아래 참고 |

### 원격 업데이트 동작

1. `git fetch` 후 현재 HEAD 기록. 추적 파일에 로컬 수정이 있으면 `git stash push`로 치우고 **stash는 지우지 않습니다** (job 결과 `note`/`gitStashRef`에 stash 커밋 표시, `git stash list`로 확인·`git stash pop`으로 복구)
2. `git pull --ff-only` (실패 시 stash를 다시 적용하고 중단)
3. `AGENT_UPDATE_REQUIRE_SIGNED=true`면 새 HEAD를 `git verify-commit` — 실패 시 `git reset --hard <이전 HEAD>` 후 error
4. `AGENT_DEPLOY_ON_UPDATE`면 루트 `npm ci` + `npm run deploy`(5분 타임아웃, 초과 시 프로세스 그룹 전체 종료)
5. agent `npm ci`
6. 4–5 중 하나라도 실패하면 `git reset --hard <이전 HEAD>` 후 `npm ci`를 다시 돌려 node_modules까지 복구하고 error 보고 (Worker 배포가 이미 끝났다면 메시지에 표시)
7. 성공하면 결과를 report로 먼저 보내고(실패 시 1회 재시도) 그 다음 `pm2 restart <PM2_APP_NAME>`. report가 두 번 다 실패해도 재시작은 함

`agent_update`가 있는 tick에서는 자동 스케줄 작업을 건너뛰고 `agent_update`를 마지막에 실행합니다. Worker 쪽에서는 결과 없이 5분이 지난 `agent_update`를 재시도하지 않고 error로 표시합니다.

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
