# Janitor

집 서버, 회선, Proxmox, 헬스 체크를 한 화면에서 다루는 콘솔입니다.  
머지된 HTML 시안(`mockup/`)을 바탕으로 **실제 Auth·DB·에이전트**로 동작하며, **샘플/더미 데이터는 포함하지 않습니다.**

## 구성

| 구성 | 역할 | 비용 |
| --- | --- | --- |
| Cloudflare Worker (`src/` + `public/`) | UI + API (`/api/*`), `*.workers.dev` | **무료** (하루 10만 요청) |
| Supabase Free | Auth, Postgres, RLS | **무료** (프로젝트 2개 등 플랜 한도) |
| Home agent (`agent/`) | 집 안 항상 켜진 기기 (cloudflared 옆) | 로컬/자택 하드웨어 |

비밀값과 환경 변수(`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SLACK_WEBHOOK_URL`, Proxmox 토큰 비밀, `AGENT_TOKEN`)는 git에 넣지 않습니다. Worker는 `.dev.vars`(로컬) / `wrangler secret`(배포)로 주입합니다.  
`SUPABASE_SERVICE_ROLE_KEY`는 `/api/agent/poll`·`/api/agent/report` 전용이며 브라우저에 노출하면 안 됩니다.

## 무료 배포 (권장: Cloudflare Workers)

> **업그레이드 순서:** `supabase/migrations/`의 새 마이그레이션을 **먼저** 적용한 뒤 Worker를 배포하고 에이전트를 업데이트하세요.
> 원격 업데이트(`agent_update`)는 `npm run deploy`만 하고 DB 마이그레이션은 돌리지 않습니다. 순서가 바뀌면 대시보드가
> 새 컬럼을 못 찾아 로드되지 않거나, 에이전트 report가 거부될 수 있습니다.

Workers Free는 계정당 **하루 10만 요청**, Worker 크기·정적 자산까지 취미/개인 콘솔에 충분합니다.  
별도 VPS나 Pages 요금 없이 `workers.dev` URL로 공개할 수 있습니다.

### 1) 본인 Cloudflare 계정에 올리기

```bash
npm install
npx wrangler login          # 브라우저에서 무료 Cloudflare 계정 연결
# Dashboard Variables 또는:
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # 에이전트 poll/report 필수 (없으면 permission denied)
# SUPABASE_URL 은 Dashboard → Settings → Variables 에 설정
npm run deploy
npx wrangler secret put SLACK_WEBHOOK_URL   # 선택
```

`permission denied for function agent_poll` 이 나오면 Worker에 `SUPABASE_SERVICE_ROLE_KEY`가 없거나 잘못된 것입니다. anon 키로는 RPC를 호출할 수 없습니다.

배포 후 URL은 wrangler 출력 / Cloudflare Dashboard에서 확인하세요. 실제 호스트명은 git에 적지 마세요.

### 커스텀 도메인 (선택)

**Workers & Pages → (Worker) → Settings → Domains & Routes → Add → Custom Domain**

DNS를 손으로 `*.workers.dev` CNAME만 걸면 SSL/라우팅이 어긋날 수 있어, Custom Domain으로 붙이는 편이 안전합니다.

### 2) Supabase Auth URL 맞추기

Supabase 대시보드 → **Authentication → URL Configuration**

- Site URL / Redirect URLs: 배포한 Worker URL (또는 연결한 커스텀 도메인)

**Authentication → Providers → Email**

- **Allow new users to sign up** → **OFF** (앱/`signUp`으로 계정 생성 불가)
- Confirm email 은 취향에 맞게 (Dashboard에서 직접 만든 사용자는 Auto Confirm 권장)

이 저장소에 연결된 Supabase 프로젝트: `ypklxfwpbyroxdolgiun` (ap-northeast-2, Free).

### 3) 홈 에이전트

```bash
cd agent
cp .env.example .env
# JANITOR_API_URL / AGENT_TOKEN 은 agent/.env 에만 넣기 (.env.example 은 localhost 예시)
npm install && npm start
```

에이전트는 집 안에서만 돌리면 되고, 클라우드 요금은 없습니다.

### 사용자 추가 (앱 회원가입 없음)

계정은 **Supabase Dashboard에서만** 만듭니다. 앱에는 가입 UI가 없습니다.

1. [Authentication → Hooks](https://supabase.com/dashboard/project/ypklxfwpbyroxdolgiun/auth/hooks)  
   **Before User Created** → Postgres → `public.hook_invite_only_signup` → Save  
   (첫 사용자는 훅이 허용합니다. 이후 사용자는 앱에서 초대해 허용 목록에 올린 뒤 Dashboard에서 생성)
2. **Authentication → Users → Add user** 로 이메일/비밀번호 생성 (Auto Confirm User 권장)
3. 추가 멤버: 앱 설정에서 이메일 초대 → 같은 이메일로 Dashboard Add user → 상대방 로그인 시 집 합류

훅이 없어도 Dashboard에서 signup을 끄면 클라이언트 `signUp`은 막힙니다. 훅은 실수로 signup이 다시 켜진 경우를 막는 이중 장치입니다.

### owner / member 권한

| 작업 | owner | member |
| --- | :---: | :---: |
| 대시보드 보기, 헬스 체크·WOL·속도 측정 요청, 서비스 추가·수정 | ✅ | ✅ |
| 서버 추가(일반)·이름/MAC 수정 | ✅ | ✅ |
| Proxmox 연동 추가·변경, 서버 삭제 | ✅ | ❌ |
| 원격 업데이트(`agent_update`), 에이전트 토큰 재발급, 초대, 집 설정 | ✅ | ❌ |

권한은 UI뿐 아니라 RLS·트리거(`20261017090000_review_hardening.sql`)에서도 강제됩니다.

### 무료 티어에서 알아둘 점

| 항목 | Free 한도 / 메모 |
| --- | --- |
| Worker 요청 | 100,000/일 (초과 시 1027) |
| CPU/요청 | 10ms — UI·짧은 API에는 여유 |
| Slack 웹훅 | Worker 시크릿만 넣으면 됨 (선택) |
| Supabase | Free 프로젝트로 Auth+DB 유지 |
| 커스텀 도메인 | 없어도 `workers.dev`로 충분 |

유료가 필요해지는 경우는 요청량이 하루 10만을 넘거나, Worker CPU가 긴 Proxmox 프록시를 Worker 안에서 돌릴 때뿐입니다. 지금 구조는 **무거운 작업은 집 에이전트**, Worker는 얇은 API라 Free에 맞습니다.

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY 필수
npm run dev
```

브라우저에서 Worker 로컬 URL을 연 뒤, Supabase에서 만든 계정으로 로그인합니다. 앱 회원가입은 없습니다.

## API 요약

- `GET /api/config` — Supabase URL/anon key + `adminProvisionedOnly` / `signupEnabled` / `inviteHookReady` (`signup_status` RPC)
- `POST /api/bootstrap` — 집 생성 (로그인 직후, 집이 없을 때)
- `POST /api/invite` — 집 초대 + Auth 허용 목록 (`invite_house_member`)
- `POST /api/servers` / `DELETE /api/servers/:id` — Proxmox 연동 추가·서버 삭제는 owner만
- `POST /api/services` — 헬스 체크 추가 (같은 주소 중복 시 409, 기본으로 첫 `health_one` 작업 자동 등록 · `checkNow:false`로 끄기)
- `PATCH /api/services/:id` — 일부 필드 수정 (주소/기대 상태가 바뀌면 결과 초기화 후 재확인)
- `DELETE /api/services/:id`
- `POST /api/jobs` — 인증된 작업 큐 enqueue (`wake`, `health_*`, `pve_sync`, `speed_probe`, `agent_update` — `agent_update`는 owner만)
- `POST /api/agent/token` — 에이전트 토큰 발급 (해시만 DB 저장)
- `GET /api/agent/poll` / `POST /api/agent/report` — 에이전트 Bearer 전용
- Cron (`*/5 * * * *`) — `janitor_maintenance`: 에이전트 10분 무응답 시 Slack 1회 알림(재연결 시 복구 알림), `speed_samples` 90일·완료/실패 job 30일 보존

## 시안

정적 시안은 `mockup/index.html`에 그대로 둡니다. 앱 UI는 `public/` 입니다.
