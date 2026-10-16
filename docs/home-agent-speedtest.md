# 집 에이전트 속도 측정 (Fast.com 스타일)

대시보드의 `speed_probe` job은 예전처럼 2MB 한 번 받는 방식이 아니라, **Fast.com처럼 여러 CDN 연결로 일정 시간 동안** 받습니다.

## 원리

1. **토큰** — `https://fast.com` → app JS에서 Netflix API token 추출 (캐시 30분)
2. **대상** — `https://api.fast.com/netflix/speedtest/v2?...&urlCount=N` 으로 OCA CDN URL 목록
3. **다운로드** — 기본 **4개 병렬** 스트림, 약 **12초** 지속  
   - 처음 ~2초는 warm-up으로 버리고 (TCP slow-start)  
   - 나머지 구간의 `읽은 바이트 × 8 / 초` → **Mbps**
4. **업로드** — Cloudflare `speed.cloudflare.com/__up` 에 POST (기본 4MiB)
5. Fast.com 실패 시(토큰·대상 조회 실패, 또는 대상은 받았지만 모든 다운로드가 실패해 0바이트) `SPEEDTEST_PROVIDER=auto`면 Cloudflare 병렬 다운로드로 폴백

## 실패 처리

- 다운로드가 0바이트면 **0 Mbps로 보고하지 않고** job을 `error`로 끝냅니다. 이때 report에 `speed`가 없습니다
- 업로드만 실패하면 `up_mbps: null` (0이 아님)
- 자동 스케줄 측정이 연속 실패하면 다음 시도를 주기 ×2, ×4(최대)로 늦춥니다

## 단위

| 필드 | 단위 |
| --- | --- |
| `down_mbps` / `up_mbps` | **Mbps** (메가비트/초), 소수 1자리. `up_mbps`는 업로드 실패/미측정 시 `null` |
| `bytes_down` / `bytes_up` | 바이트 |
| `duration_ms` | 실제 측정 구간(ms) |
| `connections` | 병렬 연결 수 |
| `provider` | `fast.com` 또는 `cloudflare` |

임계값 `speed_threshold_mbps`도 **Mbps**입니다.

## 환경 변수

```bash
SPEEDTEST_PROVIDER=auto      # auto | fast | cloudflare
SPEEDTEST_DURATION_MS=12000  # 3–60초
SPEEDTEST_CONNECTIONS=4      # 1–8
```

## 한계

- Fast.com API는 **비공식**이라 Netflix 쪽이 바꾸면 폴백(Cloudflare)으로 동작합니다.
- 상용 앱과 숫자가 완전히 같지는 않을 수 있습니다(서버·시간대·동시 트래픽).
- 업로드는 Fast.com CDN이 아니라 Cloudflare 경로입니다.
