# 집 에이전트 ↔ Cloudflare Tunnel

**Worker는 에이전트의 `/v1/*`를 직접 호출하지 않습니다.**  
에이전트가 밖으로 나가는 HTTPS로 Worker를 **폴링**합니다(`GET /api/agent/poll` → 작업 실행 → `POST /api/agent/report`).  
그래서 집 쪽에 인바운드 포트·Tunnel이 없어도 대시보드의 깨우기/헬스/Proxmox/속도 측정이 모두 동작합니다.

Tunnel은 **선택 사항**입니다. 밖에서 `/v1/*`를 수동으로 호출(디버깅, `POST /v1/poll/now`로 즉시 폴링 등)하고 싶을 때만 둡니다.

## 실제 동작 (폴링 모델)

```text
[ 대시보드 ] --(작업 등록: agent_jobs)--> [ Cloud Worker + Supabase ]
                                                ^          |
                    GET /api/agent/poll (Bearer)|          | jobs · servers · services
                    POST /api/agent/report      |          v
                                         [ 항상 켜진 기기: janitor-home-agent ]
                                                |
                                                +-- LAN: WOL 브로드캐스트, 헬스 체크, Proxmox API
```

- 주기: `AGENT_POLL_MS`(기본 15초). Worker가 응답하지 않으면 지수 백오프(최대 5분), 성공하면 원래 주기로 복귀
- 인증: `JANITOR_API_URL` + `AGENT_TOKEN`(Worker에는 토큰 해시만 저장)
- 요청마다 30초 타임아웃

같은 기기가 대상 PC와 같은 LAN에 있어 매직 패킷 브로드캐스트에 닿을 수 있어야 합니다 (Docker라면 `network_mode: host` 권장).

## 에이전트 쪽

1. `agent/.env`에 `AGENT_TOKEN`, `JANITOR_API_URL`(Worker 주소), 필요 시 `HEALTHCHECK_TOKEN` 설정
2. `pm2 start ecosystem.config.cjs` (또는 systemd/docker로 상시 실행)
3. 로컬에서 `curl http://127.0.0.1:3920/healthz`로 기동 확인
4. 대시보드 설정에서 에이전트 `agent_last_seen_at`이 갱신되는지 확인

## (선택) Tunnel로 `/v1/*` 노출

수동 호출용으로 cloudflared가 에이전트 origin을 프록시하게 할 수 있습니다.

```yaml
ingress:
  - hostname: agent.example.com
    service: http://127.0.0.1:3920
  - service: http_status:404
```

- `CF_TUNNEL_HOSTNAME=agent.example.com`을 넣으면 `/v1/status`의 `tunnelHostname`에 표시됩니다 (표시용, Worker가 이 주소로 호출하지 않음)
- 노출한다면 Cloudflare Access 등으로 한 겹 더 막는 것을 권장합니다

## 보안 체크리스트

- Tunnel hostname을 알아도 `AGENT_TOKEN` 없이는 `/v1/*` 호출 불가 (timing-safe 비교)
- 토큰·헬스 토큰을 git / 시안 UI에 넣지 않음
- `/healthz`는 프로브용이므로 민감 정보 없이 `ok`만 반환
- 헬스/Proxmox URL은 링크로컬·메타데이터 주소(169.254.0.0/16, fe80::/10, IPv4-mapped 형태 포함)와 그 주소로 해석되는 호스트명을 거부. 사설 LAN 대역은 허용

계약이 바뀌면 [`agent/contract.json`](../agent/contract.json)과 [API 문서](./home-agent-api.md)를 같이 갱신하세요.
