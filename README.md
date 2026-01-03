# Vercel Crypto Remittance System (Serverless + Cron + Discord)

**VPS/PM2/상시 데몬 없이**, **Vercel(Serverless Functions + Cron)** 만으로 운영 가능한 형태의 “코인 송금 자동화” 백엔드/디스코드 봇 예제입니다.

## 아키텍처(요약)

- **Vercel Serverless (Next.js Route Handlers)**
  - `POST /api/discord/interactions`: Discord Slash Command + Button/Select 처리 (서명 검증 포함)
  - `POST /api/ios/deposit`: iOS 단축어 기반 “은행 입금 알림 → 자동 충전” 웹훅
  - `POST /api/payments/webhook`: 결제 웹훅(일반화된 예제, 실제 PG 연동 시 교체)
  - `GET /api/quote`: 시세/김프 캐시 조회
- **Vercel Cron**
  - `GET /api/cron/refresh-prices`: 해외(USD) + 환율 + 국내(KRW) 수집 → 김프/구매가 캐시
  - `GET /api/cron/refresh-inventory`: 재고 한화 환산(총액) 캐시
- **DB (PostgreSQL)**
  - Vercel Postgres 권장. 모든 금액/수량은 **정수(BigInt)만** 사용.

## 폴더 구조

```
db/
  schema.sql
  seed.sql
scripts/
  register-commands.ts
src/
  app/
    api/
      cron/refresh-inventory/route.ts
      cron/refresh-prices/route.ts
      discord/interactions/route.ts
      health/route.ts
      ios/deposit/route.ts
      payments/webhook/route.ts
      quote/route.ts
  lib/
    alerts.ts
    constants.ts
    crypto.ts
    db.ts
    env.ts
    intmath.ts
    prices.ts
    discord/
      handlers.ts
      respond.ts
      verify.ts
vercel.json
```

## 환경변수(Vercel Environment Variables)

- **필수(Discord)**
  - `DISCORD_PUBLIC_KEY`: Interactions 서명 검증용 Public Key(hex)
  - `APP_BASE_URL`: Discord 안내 메시지용 베이스 URL (`https://xxx.vercel.app`)
- **필수(iOS 자동충전)**
  - `IOS_DEPOSIT_SHARED_SECRET`: iOS 단축어 ↔ 서버 HMAC 공유 시크릿
  - `IOS_DEPOSIT_MAX_SKEW_SEC`: 리플레이 방지 타임 윈도(기본 300초)
- **권장(DB)**
  - Vercel Postgres 연결 변수들은 Integration이 자동 주입합니다.
- **옵션(관리자 알림/권한)**
  - `ADMIN_ROLE_IDS`: 관리자 role id를 `,` 로 나열
  - `ADMIN_DISCORD_WEBHOOK_URL`: 재고부족/가격수집실패/송금요청 알림을 받을 Discord Webhook URL
- **옵션(결제 웹훅 예제)**
  - `PAYMENT_WEBHOOK_SECRET`: 결제 웹훅 HMAC 예제 시크릿
- **옵션(수수료)**
  - `FEE_BP`: 구매 수수료(basis points, 기본 150=1.5%)
  - `TRANSFER_FEE_BP`: 송금 수수료(bp, 기본 30=0.3%)

## DB 스키마 적용

1) Vercel Postgres 생성/연동 후 SQL Editor에서 `db/schema.sql` 실행  
2) 필요 시 `db/seed.sql` 실행(지원 코인 재고 row 생성)

## Discord Bot 설정(서버리스 Interactions)

1) Discord Developer Portal에서 Application 생성  
2) **Interactions Endpoint URL**을 다음으로 설정:
   - `https://<your-vercel-domain>/api/discord/interactions`
3) `DISCORD_PUBLIC_KEY`를 Vercel 환경변수로 등록
4) Slash Commands 등록:

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register-commands
```

> Discord 정책상 `/충전` 같은 **한글 명령어 이름은 불가**라서, 이 프로젝트는 `/charge`, `/balance`, `/buy`, `/send`, `/price`, `/stock`로 구현합니다(응답 텍스트는 한글).

## iOS 단축어 자동충전 흐름(실전)

**목표:** “은행 앱 입금 알림” → “iOS 단축어 파싱” → “Vercel HTTPS Webhook” → “DB 검증/중복방지” → “유저 잔액 충전”

- **단축어 단계(개요)**
  - (1) 알림(은행 입금) 텍스트 확보
  - (2) 정규식/분리로 `amountKrw`, `depositorName`, `identifier(식별값)`, `bankName` 추출
  - (3) `eventTsMs = 현재시각(ms)`, `nonce = UUID` 생성
  - (4) JSON Body 생성 후 `rawBody` 문자열로 직렬화
  - (5) `payloadHash = SHA256(rawBody)`
  - (6) `signature = HMAC-SHA256(IOS_DEPOSIT_SHARED_SECRET, payloadHash)` (hex)
  - (7) `POST https://<domain>/api/ios/deposit` 로 전송

- **서버 검증**
  - (1) `payloadHash` 계산
  - (2) HMAC 검증(위·변조 방어)
  - (3) `nonce`/`payloadHash` 유니크 인덱스로 **중복 알림 방지**
  - (4) `eventTsMs`가 `IOS_DEPOSIT_MAX_SKEW_SEC` 이내인지 확인(리플레이 방지)
  - (5) 성공 시 `balances.krw_balance += amountKrw` + `ledger_entries`/`deposit_events` 기록

## 시세/김프 계산 로직(정수 기반)

- 해외(USD): Binance spot `symbolUSDT` → `foreign_usd_price_e6 (USD*1e6)`
- 환율: USD→KRW → `fx_krw_per_usd_e4 (KRW/USD*1e4)`
- 해외원화가: \((USD*1e6) * (KRW/USD*1e4) / 1e10\)
- 국내(KRW): Upbit `KRW-<symbol>` → `domestic_krw_price (원)`
- 김프(bp): \((domestic - foreign) * 10000 / foreign\)
- 사용자 구매가: `foreign_krw_price * (10000 + kimchi_bp + fee_bp) / 10000`

Cron이 `price_cache`에 저장하고, Discord `/price`는 캐시를 Embed/텍스트로 표시합니다.

## 재고/구매/송금 모델

- `coin_inventory.available_atomic`: 실제 지갑 보유 재고(atomic)
- `coin_inventory.reserved_atomic`: 사용자 보유코인으로 **예약된** 수량(atomic)
- 구매(`/buy`):
  - KRW 차감 → `user_coin_balances` 적립 → `reserved_atomic` 증가
- 송금(`/send`):
  - 사용자 코인 차감 → `reserved_atomic` 감소
  - 실제 전송분만큼 `available_atomic` 감소(수수료 차감분은 운영자 몫으로 남음)
  - **TX 브로드캐스트는 외부 지갑 서비스 연동이 필요**하므로 예제는 `transfer_requests` 생성 후 관리자 `/admin_set_tx`로 상태/TX 업데이트

## 로컬 실행

```bash
npm install
npm run dev
```

## 배포

GitHub에 push → Vercel이 자동 배포하도록 연결하면 끝입니다.  
`vercel.json`의 Cron이 배포 후 자동으로 동작합니다.

## 확장 시 유의사항(한계/우회)

- **Vercel Cron 보안**: cron 호출은 외부에서 흉내낼 수 있으니, DB 기반 throttling + provider rate limit 대비가 필요합니다(이미 적용).
- **지갑 Private Key 금지**: 서버리스 코드에 키를 두지 말고, **커스터디/지갑 API**(Fireblocks 등) 또는 “서명 전용 KMS/외부 서비스”로 분리하세요.
- **트래픽 증가**: 가격 수집은 Cron 캐시 중심으로(이미 적용). Discord 요청마다 외부 시세 호출 금지.
- **정산/감사**: `ledger_entries`를 중심으로 모든 잔액 변화를 append-only로 남기고, 관리자 조정도 ledger로 처리하세요.
