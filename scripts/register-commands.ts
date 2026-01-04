/**
 * Register Discord application (slash) commands.
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.ts
 *
 * Notes:
 * - Discord does NOT allow Korean command names like "/충전". Use English names with Korean descriptions.
 */
import { SUPPORTED_COINS } from "../src/lib/constants";

type Command = Record<string, unknown>;

function coinChoices() {
  return SUPPORTED_COINS.map((c) => ({ name: c, value: c }));
}

const commands: Command[] = [
  {
    name: "panel",
    description: "버튼 기반 패널 열기(이후 버튼으로만 사용)",
  },
  {
    name: "charge",
    description: "충전 안내 (iOS 단축어 자동충전)",
  },
  {
    name: "balance",
    description: "내 잔액 확인(KRW/코인)",
  },
  {
    name: "price",
    description: "시세/김프 확인(캐시)",
  },
  {
    name: "stock",
    description: "재고 및 한화 환산 확인",
  },
  {
    name: "buy",
    description: "코인 구매 (KRW 잔액 차감 → 코인 잔액 적립)",
    options: [
      {
        type: 3, // STRING
        name: "symbol",
        description: "코인 심볼",
        required: true,
        choices: coinChoices(),
      },
      {
        type: 4, // INTEGER
        name: "krw",
        description: "구매 금액(원, 정수)",
        required: true,
        min_value: 1,
      },
    ],
  },
  {
    name: "send",
    description: "송금 요청 (수수료 자동 차감, TX는 관리자 등록)",
    options: [
      {
        type: 3, // STRING
        name: "symbol",
        description: "코인 심볼",
        required: true,
        choices: coinChoices(),
      },
      {
        type: 3, // STRING
        name: "address",
        description: "수신 주소",
        required: true,
      },
      {
        type: 3, // STRING
        name: "amount",
        description: "수량(예: 0.01 / 10 / 250.5)",
        required: true,
      },
    ],
  },
  {
    name: "admin_set_tx",
    description: "[관리자] 송금 요청 상태/TX 해시 업데이트",
    options: [
      {
        type: 3, // STRING
        name: "transfer_id",
        description: "transfer_requests.id (UUID)",
        required: true,
      },
      {
        type: 3, // STRING
        name: "tx_hash",
        description: "TX 해시(옵션)",
        required: false,
      },
      {
        type: 3, // STRING
        name: "status",
        description: "상태",
        required: true,
        choices: [
          { name: "broadcasted", value: "broadcasted" },
          { name: "confirmed", value: "confirmed" },
          { name: "failed", value: "failed" },
          { name: "cancelled", value: "cancelled" },
        ],
      },
    ],
  },
  {
    name: "admin_set_stock",
    description: "[관리자] 지갑 재고 설정/판매중단 해제",
    options: [
      {
        type: 3, // STRING
        name: "symbol",
        description: "코인 심볼",
        required: true,
        choices: coinChoices(),
      },
      {
        type: 3, // STRING
        name: "available",
        description: "지갑 보유 수량(예: 0.5 / 10 / 1000)",
        required: true,
      },
      {
        type: 5, // BOOLEAN
        name: "suspended",
        description: "판매 중단 여부(true면 중단)",
        required: false,
      },
    ],
  },
];

async function main() {
  const appId = process.env.DISCORD_APPLICATION_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!appId) throw new Error("Missing env: DISCORD_APPLICATION_ID");
  if (!token) throw new Error("Missing env: DISCORD_BOT_TOKEN");

  const url = `https://discord.com/api/v10/applications/${appId}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord API error ${res.status}: ${text}`);
  }
  console.log("Registered commands OK:", text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

