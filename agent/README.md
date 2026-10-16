# Janitor home agent

항상 켜진 기기에서 돌리는 집 에이전트입니다. Worker(`JANITOR_API_URL`)를 **폴링**해서 작업을 가져가므로 인바운드 포트·Tunnel은 필요 없습니다.

문서:

- [개요 · 환경 변수 · 로컬 실행](../docs/home-agent.md)
- [HTTP API](../docs/home-agent-api.md)
- [폴링 모델 · (선택) Cloudflare Tunnel](../docs/home-agent-tunnel.md)
- [속도 측정](../docs/home-agent-speedtest.md)
- [docs 인덱스](../docs/README.md)

기계용 계약: [`contract.json`](./contract.json)

## 빠른 실행

```bash
cd agent
cp .env.example .env   # AGENT_TOKEN=... 한 줄 넣기
npm install
npm test
npm start
```

기동 시 `agent/.env`를 자동으로 읽습니다.  
당장 안 되면 `AGENT_TOKEN=값 npm start`로도 됩니다.

개발: `npm run dev` (`tsx watch`, 저장 시 자동 재시작).  
상시 실행: `pm2 start ecosystem.config.cjs` — pm2 앱 이름은 `janitor-agent`이고 `PM2_APP_NAME`도 같은 값이어야 원격 업데이트 후 재시작됩니다.

기본 포트 `3920`. `/v1/*`(로컬/LAN 수동 호출용)는 `Authorization: Bearer $AGENT_TOKEN` 필요.

자주 묻는 설정:

| 상황 | 설정 |
| --- | --- |
| 헬스 체크에 토큰이 필요한 서비스 | `HEALTHCHECK_TOKEN` + 대시보드에서 그 서비스만 **헬스 토큰 사용**(`use_health_token`) 켜기. 끈 서비스에는 토큰을 보내지 않음 |
| Proxmox 자체 서명 인증서 | 권장: `NODE_EXTRA_CA_CERTS=/path/pve-root-ca.pem`. 최후 수단: `PVE_TLS_INSECURE=true` |
| 서명된 커밋만 원격 업데이트 | `AGENT_UPDATE_REQUIRE_SIGNED=true` (`git verify-commit` 통과 필요) |
| 원격 업데이트 실패 | 자동으로 이전 커밋으로 `git reset --hard` + `npm ci` 복구. 로컬 수정은 `git stash list`에 보관 |
