# Janitor

집 서버, 회선, Proxmox, 헬스 체크를 한 화면에서 다루는 콘솔입니다.  
머지된 HTML 시안(`mockup/`)을 바탕으로 **실제 Auth·DB·에이전트**로 동작하며, **샘플/더미 데이터는 포함하지 않습니다.**

## 구성

| 구성 | 역할 |
| --- | --- |
| Cloudflare Worker (`src/`) | UI 정적 파일 + API (`/api/*`) |
| Supabase | Auth, 집/서버/서비스/속도 기록, RLS |
| Home agent (`agent/`) | WOL, 공인 IP, 헬스 체크, Proxmox 동기화, 속도 측정 (cloudflared 옆 상시 기기) |

비밀값(`SLACK_WEBHOOK_URL`, `UPLUS_ROUTER_PASSWORD`, Proxmox 토큰 비밀, `AGENT_TOKEN`)은 git에 넣지 않습니다.

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # 선택: SLACK_WEBHOOK_URL
npm run dev
```

브라우저에서 Worker 로컬 URL을 연 뒤 **계정 만들기**로 빈 집을 만듭니다. 서버·서비스 샘플은 넣지 않습니다.

### 홈 에이전트

```bash
cd agent
cp .env.example .env
# 콘솔 설정에서 발급한 AGENT_TOKEN, 배포된 JANITOR_API_URL 입력
npm install
npm start
```

에이전트가 폴링하면 현황의 공인 IP·서버 on/off·헬스·속도가 채워집니다.

## 배포

```bash
npx wrangler secret put SLACK_WEBHOOK_URL   # 선택
npm run deploy
```

Supabase 대시보드에서 **Authentication → Providers → Email → Confirm email** 을 끄면 가입 직후 바로 로그인됩니다.  
Authentication → URL Configuration에 Worker URL을 Site URL / Redirect URLs로 추가하세요.

이 저장소에 연결된 Supabase 프로젝트: `ypklxfwpbyroxdolgiun` (ap-northeast-2).

## API 요약

- `GET /api/config` — 공개 Supabase URL/anon key
- `POST /api/bootstrap` — 집 생성 (가입 직후)
- `POST /api/servers` / `DELETE /api/servers/:id`
- `POST /api/services` / `DELETE /api/services/:id`
- `POST /api/jobs` — 에이전트 작업 큐 (wake, health_*, pve_sync, speed_probe)
- `POST /api/agent/token` — 에이전트 토큰 발급 (해시만 DB 저장)
- `GET /api/agent/poll` / `POST /api/agent/report` — 에이전트 전용

## 시안

정적 시안은 `mockup/index.html`에 그대로 둡니다. 앱 UI는 `public/` 입니다.
