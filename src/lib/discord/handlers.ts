import { sql } from "@vercel/postgres";
import type {
  APIApplicationCommandInteraction,
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIInteractionResponse,
} from "discord-api-types/v10";
import { InteractionType } from "discord-api-types/v10";
import { errorMessage, message, modal, pong } from "@/lib/discord/respond";
import { COIN_UNIT_SCALE, SUPPORTED_COINS, type CoinSymbol } from "@/lib/constants";
import { formatAtomicToDecimal, parseDecimalToInt } from "@/lib/intmath";
import { withTx, ensureUser } from "@/lib/db";
import { alert } from "@/lib/alerts";
import { pgBigint, pgJson } from "@/lib/pg";
import { actionRow, button, paragraphInput, selectMenu, textInput } from "@/lib/discord/ui";

function getInvokerDiscordId(i: APIInteraction): bigint | null {
  const anyI = i as unknown as {
    member?: { user?: { id?: string } };
    user?: { id?: string };
  };
  const id = anyI.member?.user?.id ?? anyI.user?.id;
  if (!id || !/^\d+$/.test(String(id))) return null;
  return BigInt(String(id));
}

function isAdmin(i: APIInteraction): boolean {
  const anyI = i as unknown as { member?: { roles?: string[] } };
  const roles: string[] = anyI.member?.roles ?? [];
  const adminRoles = new Set(
    String(process.env.ADMIN_ROLE_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (!adminRoles.size) return false;
  return roles.some((r) => adminRoles.has(r));
}

function getOptionValue(i: APIChatInputApplicationCommandInteraction, name: string): unknown {
  const data = i.data as unknown as { options?: Array<{ name: string; value?: unknown }> };
  const opts = data.options ?? [];
  return opts.find((o) => o.name === name)?.value;
}

function coinChoiceOrThrow(v: unknown): CoinSymbol {
  const s = String(v ?? "").toUpperCase().trim();
  if (!(SUPPORTED_COINS as readonly string[]).includes(s)) throw new Error("unsupported_coin");
  return s as CoinSymbol;
}

function encUser(discordId: bigint): string {
  return discordId.toString();
}

function ensureSameUser(i: APIInteraction, expectedDiscordId: string): string | null {
  const invoker = getInvokerDiscordId(i);
  if (!invoker) return "유저 식별에 실패했습니다.";
  if (invoker.toString() !== expectedDiscordId) return "이 UI는 요청한 사용자만 사용할 수 있습니다.";
  return null;
}

function panelComponents() {
  return [
    actionRow([
      button("panel:charge", "충전", 1),
      button("panel:balance", "잔액", 2),
      button("panel:price", "시세", 2),
      button("panel:stock", "재고", 2),
    ]),
    actionRow([button("panel:buy", "코인구매", 3), button("panel:send", "송금", 4)]),
  ];
}

export async function handleDiscordInteraction(i: APIInteraction): Promise<APIInteractionResponse> {
  if (i.type === InteractionType.Ping) return pong();

  try {
    if (i.type === InteractionType.ApplicationCommand) {
      const cmd = (i as APIApplicationCommandInteraction).data?.name;
      const discordId = getInvokerDiscordId(i);
      if (!discordId) return errorMessage("유저 식별에 실패했습니다.");

      switch (cmd) {
        case "panel":
          return cmdPanel();
        case "charge":
          return await cmdCharge(discordId);
        case "balance":
          return await cmdBalance(discordId);
        case "price":
          return await cmdPrice();
        case "stock":
          return await cmdStock();
        case "buy":
          return await cmdBuy(i as APIChatInputApplicationCommandInteraction, discordId);
        case "send":
          return await cmdSend(i as APIChatInputApplicationCommandInteraction, discordId);
        case "admin_set_tx":
          if (!isAdmin(i)) return errorMessage("권한이 없습니다(관리자 전용).");
          return await cmdAdminSetTx(i as APIChatInputApplicationCommandInteraction);
        case "admin_set_stock":
          if (!isAdmin(i)) return errorMessage("권한이 없습니다(관리자 전용).");
          return await cmdAdminSetStock(i as APIChatInputApplicationCommandInteraction);
        default:
          return errorMessage(`알 수 없는 명령어입니다: ${cmd}`);
      }
    }

    // Button / SelectMenu
    if (i.type === InteractionType.MessageComponent) {
      const data = i.data as unknown as { custom_id?: string; values?: string[] };
      const customId = data.custom_id ?? "";

      if (customId === "panel:charge") {
        const discordId = getInvokerDiscordId(i);
        if (!discordId) return errorMessage("유저 식별에 실패했습니다.");
        return await cmdCharge(discordId);
      }
      if (customId === "panel:balance") {
        const discordId = getInvokerDiscordId(i);
        if (!discordId) return errorMessage("유저 식별에 실패했습니다.");
        return await cmdBalance(discordId);
      }
      if (customId === "panel:price") return await cmdPrice();
      if (customId === "panel:stock") return await cmdStock();

      if (customId === "panel:buy") {
        const discordId = getInvokerDiscordId(i);
        if (!discordId) return errorMessage("유저 식별에 실패했습니다.");
        const uid = encUser(discordId);
        return message("구매할 코인을 선택하세요.", {
          ephemeral: true,
          components: [actionRow([selectMenu(`buy:select:${uid}`, "코인 선택")])],
        });
      }
      if (customId === "panel:send") {
        const discordId = getInvokerDiscordId(i);
        if (!discordId) return errorMessage("유저 식별에 실패했습니다.");
        const uid = encUser(discordId);
        return message("송금할 코인을 선택하세요.", {
          ephemeral: true,
          components: [actionRow([selectMenu(`send:select:${uid}`, "코인 선택")])],
        });
      }

      if (customId.startsWith("buy:select:")) {
        const [, , uid] = customId.split(":");
        const err = ensureSameUser(i, uid);
        if (err) return errorMessage(err);
        const symbol = (data.values?.[0] ?? "").toUpperCase();
        if (!(SUPPORTED_COINS as readonly string[]).includes(symbol)) return errorMessage("코인 선택이 올바르지 않습니다.");

        return modal({
          custom_id: `buy:modal:${uid}:${symbol}`,
          title: `구매(${symbol})`,
          components: [
            actionRow([textInput("krw", "구매 금액 (원, 정수)", { placeholder: "예: 100000" })]),
          ],
        });
      }

      if (customId.startsWith("send:select:")) {
        const [, , uid] = customId.split(":");
        const err = ensureSameUser(i, uid);
        if (err) return errorMessage(err);
        const symbol = (data.values?.[0] ?? "").toUpperCase();
        if (!(SUPPORTED_COINS as readonly string[]).includes(symbol)) return errorMessage("코인 선택이 올바르지 않습니다.");

        return modal({
          custom_id: `send:modal:${uid}:${symbol}`,
          title: `송금(${symbol})`,
          components: [
            actionRow([paragraphInput("address", "수신 주소", { placeholder: "지갑 주소를 붙여넣기" })]),
            actionRow([textInput("amount", "수량", { placeholder: "예: 0.01 / 10 / 250.5" })]),
          ],
        });
      }

      return errorMessage("알 수 없는 버튼/메뉴 입니다.");
    }

    // Modal submit
    if (i.type === InteractionType.ModalSubmit) {
      const data = i.data as unknown as {
        custom_id?: string;
        components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
      };
      const customId = data.custom_id ?? "";

      const fields: Record<string, string> = {};
      for (const row of data.components ?? []) {
        for (const c of row.components ?? []) {
          if (c.custom_id && typeof c.value === "string") fields[c.custom_id] = c.value;
        }
      }

      if (customId.startsWith("buy:modal:")) {
        const [, , uid, symbol] = customId.split(":");
        const err = ensureSameUser(i, uid);
        if (err) return errorMessage(err);
        const krw = BigInt(Number(fields.krw ?? 0));
        if (krw <= 0n) return errorMessage("구매 금액이 올바르지 않습니다.");

        // Reuse existing buy logic via a lightweight wrapper: perform the same DB operations.
        return await cmdBuyFromPanel(BigInt(uid), symbol as CoinSymbol, krw);
      }

      if (customId.startsWith("send:modal:")) {
        const [, , uid, symbol] = customId.split(":");
        const err = ensureSameUser(i, uid);
        if (err) return errorMessage(err);
        const address = String(fields.address ?? "").trim();
        const amount = String(fields.amount ?? "").trim();
        if (!address) return errorMessage("주소가 비어있습니다.");
        if (!amount) return errorMessage("수량이 비어있습니다.");

        return await cmdSendFromPanel(BigInt(uid), symbol as CoinSymbol, address, amount);
      }

      return errorMessage("알 수 없는 모달입니다.");
    }

    return errorMessage("지원하지 않는 인터랙션 타입입니다.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorMessage(`처리 중 오류: ${msg}`);
  }
}

function cmdPanel(): APIInteractionResponse {
  return message("**코인봇 패널**\n버튼으로 충전/조회/구매/송금을 진행하세요.", {
    ephemeral: false,
    components: panelComponents(),
  });
}

async function cmdCharge(discordId: bigint): Promise<APIInteractionResponse> {
  const base = process.env.APP_BASE_URL ?? "(APP_BASE_URL 미설정)";
  const url = `${base}/api/ios/deposit`;

  return message(
    [
      "**충전 안내 (iOS 단축어 자동입금 전용)**",
      `- **내 Discord ID**: \`${discordId.toString()}\``,
      `- **단축어 Webhook URL**: \`${url}\``,
      "",
      "단축어에서 **알림 텍스트 → (금액/입금자/식별값) 파싱** 후 아래 필드로 POST 하세요:",
      "- discordId(문자열 숫자), amountKrw(정수), depositorName, bankName, identifier, eventTsMs, nonce, signature",
    ].join("\n"),
    { ephemeral: true }
  );
}

async function cmdBalance(discordId: bigint): Promise<APIInteractionResponse> {
  await withTx(async (tx) => ensureUser(tx, discordId));

  const b = await sql<{ krw_balance: string }>`
    SELECT krw_balance::text AS krw_balance
    FROM balances
    WHERE discord_id = ${pgBigint(discordId)}::bigint
  `;
  const krw = b.rows[0] ? BigInt(b.rows[0].krw_balance) : 0n;

  const c = await sql<{ symbol: string; balance_atomic: string }>`
    SELECT symbol, balance_atomic::text AS balance_atomic
    FROM user_coin_balances
    WHERE discord_id = ${pgBigint(discordId)}::bigint
    ORDER BY symbol ASC
  `;

  const lines: string[] = [];
  lines.push(`**KRW 잔액**: \`${krw.toString()}원\``);
  if (!c.rows.length) {
    lines.push("**코인 잔액**: 없음");
  } else {
    lines.push("**코인 잔액**:");
    for (const row of c.rows) {
      const sym = row.symbol as CoinSymbol;
      const atomic = BigInt(row.balance_atomic);
      const scale = COIN_UNIT_SCALE[sym] ?? 1n;
      lines.push(`- ${sym}: \`${formatAtomicToDecimal(atomic, scale)}\``);
    }
  }

  return message(lines.join("\n"), { ephemeral: true });
}

async function cmdPrice(): Promise<APIInteractionResponse> {
  const r = await sql<{
    symbol: string;
    domestic_krw_price: string;
    buy_krw_price: string;
    kimchi_bp: number;
    fee_bp: number;
    updated_at: string;
  }>`
    SELECT
      symbol,
      domestic_krw_price::text AS domestic_krw_price,
      buy_krw_price::text AS buy_krw_price,
      kimchi_bp,
      fee_bp,
      updated_at
    FROM price_cache
    ORDER BY symbol ASC
  `;
  if (!r.rows.length) return errorMessage("시세 캐시가 비어있습니다. 크론 실행 후 다시 시도하세요.");

  const lines: string[] = ["**시세/김프 (캐시)**"];
  for (const row of r.rows) {
    const kimchiPct = (Number(row.kimchi_bp) / 100).toFixed(2);
    const feePct = (Number(row.fee_bp) / 100).toFixed(2);
    lines.push(
      `- ${row.symbol}: 국내 \`${row.domestic_krw_price}원\` | 구매가 \`${row.buy_krw_price}원\` | 김프 ${kimchiPct}% | 수수료 ${feePct}%`
    );
  }
  return message(lines.join("\n"), { ephemeral: false });
}

async function cmdStock(): Promise<APIInteractionResponse> {
  const r = await sql<{
    symbol: string;
    available_atomic: string;
    unit_scale: number;
    price_krw: string;
    value_krw: string;
    updated_at: string;
  }>`
    SELECT
      v.symbol,
      v.available_atomic::text AS available_atomic,
      v.unit_scale,
      v.price_krw::text AS price_krw,
      v.value_krw::text AS value_krw,
      v.updated_at
    FROM inventory_valuation v
    ORDER BY v.symbol ASC
  `;

  if (!r.rows.length) {
    return errorMessage("재고 환산 캐시가 비어있습니다. 크론 실행 후 다시 시도하세요.");
  }

  let total = 0n;
  const lines: string[] = ["**재고(한화 환산)**"];
  for (const row of r.rows) {
    total += BigInt(row.value_krw);
    const scale = BigInt(row.unit_scale);
    const atomic = BigInt(row.available_atomic);
    lines.push(`- ${row.symbol}: \`${formatAtomicToDecimal(atomic, scale)}\` ≈ \`${row.value_krw}원\``);
  }
  lines.push(`**총 재고**: \`${total.toString()}원\``);
  return message(lines.join("\n"));
}

async function cmdBuyFromPanel(discordId: bigint, symbol: CoinSymbol, amountKrw: bigint): Promise<APIInteractionResponse> {
  // Minimal input validation
  if (!(SUPPORTED_COINS as readonly string[]).includes(symbol)) return errorMessage("지원하지 않는 코인입니다.");
  if (amountKrw <= 0n) return errorMessage("구매 금액이 올바르지 않습니다.");

  // Use same core buy flow but without slash options
  const unitScale = COIN_UNIT_SCALE[symbol];

  const price = await sql<{
    buy_krw_price: string;
    kimchi_bp: number;
    fee_bp: number;
    sources: unknown;
    updated_at: string;
  }>`
    SELECT buy_krw_price::text AS buy_krw_price, kimchi_bp, fee_bp, sources, updated_at
    FROM price_cache
    WHERE symbol = ${symbol}
    LIMIT 1
  `;
  if (!price.rows.length) return errorMessage("해당 코인의 시세 캐시가 없습니다. 잠시 후 다시 시도하세요.");

  const priceRow = price.rows[0];
  const buyPriceKrw = BigInt(priceRow.buy_krw_price);
  const coinAtomic = (amountKrw * unitScale) / buyPriceKrw;
  if (coinAtomic <= 0n) return errorMessage("구매 금액이 너무 작습니다(코인 수량이 0).");

  const order = await withTx(async (tx) => {
    await ensureUser(tx, discordId);

    await tx`
      INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
      VALUES (${symbol}, 0, 0, false)
      ON CONFLICT (symbol) DO NOTHING
    `;

    const b = await tx<{ krw_balance: string }>`
      SELECT krw_balance::text AS krw_balance
      FROM balances
      WHERE discord_id = ${pgBigint(discordId)}::bigint
      FOR UPDATE
    `;
    const krwBal = b.rows[0] ? BigInt(b.rows[0].krw_balance) : 0n;
    if (krwBal < amountKrw) throw new Error("잔액이 부족합니다.");

    const inv = await tx<{ available_atomic: string; reserved_atomic: string; suspended: boolean }>`
      SELECT available_atomic::text AS available_atomic, reserved_atomic::text AS reserved_atomic, suspended
      FROM coin_inventory
      WHERE symbol = ${symbol}
      FOR UPDATE
    `;
    const available = inv.rows[0] ? BigInt(inv.rows[0].available_atomic) : 0n;
    const reserved = inv.rows[0] ? BigInt(inv.rows[0].reserved_atomic) : 0n;
    const sellable = available - reserved;
    if (inv.rows[0]?.suspended) throw new Error("현재 재고 부족으로 판매가 중단되었습니다.");
    if (sellable < coinAtomic) {
      await tx`UPDATE coin_inventory SET suspended = true, updated_at = now() WHERE symbol = ${symbol}`;
      await alert("inventory_low", `${symbol} 재고 부족으로 판매 중단(구매 요청).`, {
        symbol,
        available: available.toString(),
        reserved: reserved.toString(),
        requested: coinAtomic.toString(),
      });
      throw new Error("재고가 부족합니다(판매 중단).");
    }

    await tx`
      UPDATE balances
      SET krw_balance = krw_balance - ${pgBigint(amountKrw)}::bigint, updated_at = now()
      WHERE discord_id = ${pgBigint(discordId)}::bigint
    `;
    await tx`
      INSERT INTO ledger_entries (discord_id, kind, delta_krw)
      VALUES (${pgBigint(discordId)}::bigint, 'purchase', ${pgBigint(-amountKrw)}::bigint)
    `;
    await tx`
      INSERT INTO user_coin_balances (discord_id, symbol, balance_atomic)
      VALUES (${pgBigint(discordId)}::bigint, ${symbol}, ${pgBigint(coinAtomic)}::bigint)
      ON CONFLICT (discord_id, symbol) DO UPDATE SET
        balance_atomic = user_coin_balances.balance_atomic + EXCLUDED.balance_atomic,
        updated_at = now()
    `;
    await tx`
      UPDATE coin_inventory
      SET reserved_atomic = reserved_atomic + ${pgBigint(coinAtomic)}::bigint, updated_at = now()
      WHERE symbol = ${symbol}
    `;

    const created = await tx<{ id: string }>`
      INSERT INTO purchase_orders (
        discord_id, symbol, krw_spent, coin_amount_atomic, unit_scale, fee_bp, kimchi_bp, price_snapshot, status
      )
      VALUES (
        ${pgBigint(discordId)}::bigint,
        ${symbol},
        ${pgBigint(amountKrw)}::bigint,
        ${pgBigint(coinAtomic)}::bigint,
        ${Number(unitScale)},
        ${Number(priceRow.fee_bp)},
        ${Number(priceRow.kimchi_bp)},
        ${pgJson(priceRow)}::jsonb,
        'filled'
      )
      RETURNING id::text AS id
    `;

    return { orderId: created.rows[0].id, coinAtomic };
  });

  return message(
    [
      `✅ 구매 완료`,
      `- 코인: **${symbol}**`,
      `- 사용 KRW: \`${amountKrw.toString()}원\``,
      `- 적립 수량: \`${formatAtomicToDecimal(order.coinAtomic, unitScale)}\``,
      `- 주문 ID: \`${order.orderId}\``,
    ].join("\n"),
    { ephemeral: true }
  );
}

async function cmdSendFromPanel(discordId: bigint, symbol: CoinSymbol, to: string, amountStr: string) {
  if (!(SUPPORTED_COINS as readonly string[]).includes(symbol)) return errorMessage("지원하지 않는 코인입니다.");
  const unitScale = COIN_UNIT_SCALE[symbol];
  const amountAtomic = parseDecimalToInt(amountStr, unitScale);
  if (amountAtomic <= 0n) return errorMessage("송금 수량이 올바르지 않습니다.");

  // Reuse core send flow by building the same operations
  const transferFeeBp = Number(process.env.TRANSFER_FEE_BP ?? "30");
  const feeAtomic = (amountAtomic * BigInt(transferFeeBp)) / 10_000n;
  const sendAtomic = amountAtomic - feeAtomic;
  if (sendAtomic <= 0n) return errorMessage("송금 수수료가 수량보다 큽니다.");

  const transferId = await withTx(async (tx) => {
    await ensureUser(tx, discordId);

    const ub = await tx<{ balance_atomic: string }>`
      SELECT balance_atomic::text AS balance_atomic
      FROM user_coin_balances
      WHERE discord_id = ${pgBigint(discordId)}::bigint AND symbol = ${symbol}
      FOR UPDATE
    `;
    const userBal = ub.rows[0] ? BigInt(ub.rows[0].balance_atomic) : 0n;
    if (userBal < amountAtomic) throw new Error("코인 잔액이 부족합니다.");

    await tx`
      UPDATE user_coin_balances
      SET balance_atomic = balance_atomic - ${pgBigint(amountAtomic)}::bigint, updated_at = now()
      WHERE discord_id = ${pgBigint(discordId)}::bigint AND symbol = ${symbol}
    `;

    await tx`
      INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
      VALUES (${symbol}, 0, 0, false)
      ON CONFLICT (symbol) DO NOTHING
    `;
    const inv = await tx<{ available_atomic: string; reserved_atomic: string }>`
      SELECT available_atomic::text AS available_atomic, reserved_atomic::text AS reserved_atomic
      FROM coin_inventory
      WHERE symbol = ${symbol}
      FOR UPDATE
    `;
    const available = inv.rows[0] ? BigInt(inv.rows[0].available_atomic) : 0n;
    const reserved = inv.rows[0] ? BigInt(inv.rows[0].reserved_atomic) : 0n;
    if (reserved < amountAtomic) throw new Error("내부 재고(예약)가 부족합니다. 관리자에게 문의하세요.");
    if (available < sendAtomic) {
      await alert("inventory_low", `${symbol} 지갑 재고 부족(송금 요청).`, {
        symbol,
        available: available.toString(),
        required_send: sendAtomic.toString(),
      });
      throw new Error("현재 지갑 재고가 부족합니다(관리자 처리 필요).");
    }

    await tx`
      UPDATE coin_inventory
      SET
        reserved_atomic = reserved_atomic - ${pgBigint(amountAtomic)}::bigint,
        available_atomic = available_atomic - ${pgBigint(sendAtomic)}::bigint,
        updated_at = now()
      WHERE symbol = ${symbol}
    `;

    const created = await tx<{ id: string }>`
      INSERT INTO transfer_requests (
        discord_id, symbol, to_address, coin_amount_atomic, fee_coin_atomic, unit_scale, status
      )
      VALUES (
        ${pgBigint(discordId)}::bigint,
        ${symbol},
        ${to},
        ${pgBigint(sendAtomic)}::bigint,
        ${pgBigint(feeAtomic)}::bigint,
        ${Number(unitScale)},
        'requested'
      )
      RETURNING id::text AS id
    `;

    await tx`
      INSERT INTO admin_alerts (kind, message, context)
      VALUES (
        'transfer_requested',
        ${`${symbol} 송금 요청: ${sendAtomic.toString()} (fee ${feeAtomic.toString()})`},
        ${pgJson({
          discordId: discordId.toString(),
          symbol,
          to,
          sendAtomic: sendAtomic.toString(),
          feeAtomic: feeAtomic.toString(),
          transferId: created.rows[0].id,
        })}::jsonb
      )
    `;

    return created.rows[0].id;
  });

  await alert("transfer_requested", `${symbol} 송금 요청 생성됨: ${transferId}`, {
    transferId,
    discordId: discordId.toString(),
    symbol,
    to,
    sendAtomic: sendAtomic.toString(),
    feeAtomic: feeAtomic.toString(),
  });

  return message(
    [
      "✅ 송금 요청이 접수되었습니다(자동 브로드캐스트는 지갑 API 연동 필요).",
      `- 코인: **${symbol}**`,
      `- 수신지: \`${to}\``,
      `- 요청 수량: \`${formatAtomicToDecimal(amountAtomic, unitScale)}\``,
      `- 수수료: \`${formatAtomicToDecimal(feeAtomic, unitScale)}\``,
      `- 실제 전송: \`${formatAtomicToDecimal(sendAtomic, unitScale)}\``,
      `- 요청 ID: \`${transferId}\``,
    ].join("\n"),
    { ephemeral: true }
  );
}

async function cmdBuy(i: APIChatInputApplicationCommandInteraction, discordId: bigint): Promise<APIInteractionResponse> {
  const symbol = coinChoiceOrThrow(getOptionValue(i, "symbol"));
  const amountKrw = BigInt(Number(getOptionValue(i, "krw") ?? 0));
  if (amountKrw <= 0n) return errorMessage("krw 옵션이 올바르지 않습니다.");

  const unitScale = COIN_UNIT_SCALE[symbol];

  const price = await sql<{
    buy_krw_price: string;
    kimchi_bp: number;
    fee_bp: number;
    sources: unknown;
    updated_at: string;
  }>`
    SELECT buy_krw_price::text AS buy_krw_price, kimchi_bp, fee_bp, sources, updated_at
    FROM price_cache
    WHERE symbol = ${symbol}
    LIMIT 1
  `;
  if (!price.rows.length) return errorMessage("해당 코인의 시세 캐시가 없습니다. 잠시 후 다시 시도하세요.");

  const priceRow = price.rows[0];
  const buyPriceKrw = BigInt(priceRow.buy_krw_price);
  const coinAtomic = (amountKrw * unitScale) / buyPriceKrw;
  if (coinAtomic <= 0n) return errorMessage("구매 금액이 너무 작습니다(코인 수량이 0).");

  try {
    const order = await withTx(async (tx) => {
      await ensureUser(tx, discordId);

      // Ensure inventory row
      await tx`
        INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
        VALUES (${symbol}, 0, 0, false)
        ON CONFLICT (symbol) DO NOTHING
      `;

      const b = await tx<{ krw_balance: string }>`
        SELECT krw_balance::text AS krw_balance
        FROM balances
        WHERE discord_id = ${pgBigint(discordId)}::bigint
        FOR UPDATE
      `;
      const krwBal = b.rows[0] ? BigInt(b.rows[0].krw_balance) : 0n;
      if (krwBal < amountKrw) throw new Error("잔액이 부족합니다.");

      const inv = await tx<{ available_atomic: string; reserved_atomic: string; suspended: boolean }>`
        SELECT available_atomic::text AS available_atomic, reserved_atomic::text AS reserved_atomic, suspended
        FROM coin_inventory
        WHERE symbol = ${symbol}
        FOR UPDATE
      `;
      const available = inv.rows[0] ? BigInt(inv.rows[0].available_atomic) : 0n;
      const reserved = inv.rows[0] ? BigInt(inv.rows[0].reserved_atomic) : 0n;
      const sellable = available - reserved;
      if (inv.rows[0]?.suspended) throw new Error("현재 재고 부족으로 판매가 중단되었습니다.");
      if (sellable < coinAtomic) {
        await tx`UPDATE coin_inventory SET suspended = true, updated_at = now() WHERE symbol = ${symbol}`;
        await alert("inventory_low", `${symbol} 재고 부족으로 판매 중단(구매 요청).`, {
          symbol,
          available: available.toString(),
          reserved: reserved.toString(),
          requested: coinAtomic.toString(),
        });
        throw new Error("재고가 부족합니다(판매 중단).");
      }

      // Deduct KRW
      await tx`
        UPDATE balances
        SET krw_balance = krw_balance - ${pgBigint(amountKrw)}::bigint, updated_at = now()
        WHERE discord_id = ${pgBigint(discordId)}::bigint
      `;
      await tx`
        INSERT INTO ledger_entries (discord_id, kind, delta_krw)
        VALUES (${pgBigint(discordId)}::bigint, 'purchase', ${pgBigint(-amountKrw)}::bigint)
      `;

      // Credit user coin balance
      await tx`
        INSERT INTO user_coin_balances (discord_id, symbol, balance_atomic)
        VALUES (${pgBigint(discordId)}::bigint, ${symbol}, ${pgBigint(coinAtomic)}::bigint)
        ON CONFLICT (discord_id, symbol) DO UPDATE SET
          balance_atomic = user_coin_balances.balance_atomic + EXCLUDED.balance_atomic,
          updated_at = now()
      `;

      // Reserve inventory (allocated to users)
      await tx`
        UPDATE coin_inventory
        SET reserved_atomic = reserved_atomic + ${pgBigint(coinAtomic)}::bigint, updated_at = now()
        WHERE symbol = ${symbol}
      `;

      const created = await tx<{ id: string }>`
        INSERT INTO purchase_orders (
          discord_id, symbol, krw_spent, coin_amount_atomic, unit_scale, fee_bp, kimchi_bp, price_snapshot, status
        )
        VALUES (
          ${pgBigint(discordId)}::bigint,
          ${symbol},
          ${pgBigint(amountKrw)}::bigint,
          ${pgBigint(coinAtomic)}::bigint,
          ${Number(unitScale)},
          ${Number(priceRow.fee_bp)},
          ${Number(priceRow.kimchi_bp)},
          ${pgJson(priceRow)}::jsonb,
          'filled'
        )
        RETURNING id::text AS id
      `;

      return { orderId: created.rows[0].id, coinAtomic };
    });

    return message(
      [
        `✅ 구매 완료`,
        `- 코인: **${symbol}**`,
        `- 사용 KRW: \`${amountKrw.toString()}원\``,
        `- 적립 수량: \`${formatAtomicToDecimal(order.coinAtomic, unitScale)}\``,
        `- 주문 ID: \`${order.orderId}\``,
        "",
        "보유 코인은 `/send` 로 송금 요청할 수 있습니다.",
      ].join("\n"),
      { ephemeral: true }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "구매 실패";
    return errorMessage(msg);
  }
}

async function cmdSend(i: APIChatInputApplicationCommandInteraction, discordId: bigint): Promise<APIInteractionResponse> {
  const transferFeeBp = Number(process.env.TRANSFER_FEE_BP ?? "30");
  const symbol = coinChoiceOrThrow(getOptionValue(i, "symbol"));
  const to = String(getOptionValue(i, "address") ?? "").trim();
  const amountStr = String(getOptionValue(i, "amount") ?? "").trim();
  if (!to) return errorMessage("address 옵션이 필요합니다.");
  if (!amountStr) return errorMessage("amount 옵션이 필요합니다.");

  const unitScale = COIN_UNIT_SCALE[symbol];
  const amountAtomic = parseDecimalToInt(amountStr, unitScale);
  if (amountAtomic <= 0n) return errorMessage("송금 수량이 올바르지 않습니다.");

  const feeAtomic = (amountAtomic * BigInt(transferFeeBp)) / 10_000n;
  const sendAtomic = amountAtomic - feeAtomic;
  if (sendAtomic <= 0n) return errorMessage("송금 수수료가 수량보다 큽니다.");

  const transferId = await withTx(async (tx) => {
    await ensureUser(tx, discordId);

    // Lock balances and inventory
    const ub = await tx<{ balance_atomic: string }>`
      SELECT balance_atomic::text AS balance_atomic
      FROM user_coin_balances
      WHERE discord_id = ${pgBigint(discordId)}::bigint AND symbol = ${symbol}
      FOR UPDATE
    `;
    const userBal = ub.rows[0] ? BigInt(ub.rows[0].balance_atomic) : 0n;
    if (userBal < amountAtomic) throw new Error("코인 잔액이 부족합니다.");

    await tx`
      UPDATE user_coin_balances
      SET balance_atomic = balance_atomic - ${pgBigint(amountAtomic)}::bigint, updated_at = now()
      WHERE discord_id = ${pgBigint(discordId)}::bigint AND symbol = ${symbol}
    `;

    // Inventory accounting:
    // - reserved_atomic decreases by user's total (amountAtomic)
    // - available_atomic decreases by actually sent amount (sendAtomic)
    await tx`
      INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
      VALUES (${symbol}, 0, 0, false)
      ON CONFLICT (symbol) DO NOTHING
    `;
    const inv = await tx<{ available_atomic: string; reserved_atomic: string }>`
      SELECT available_atomic::text AS available_atomic, reserved_atomic::text AS reserved_atomic
      FROM coin_inventory
      WHERE symbol = ${symbol}
      FOR UPDATE
    `;
    const available = inv.rows[0] ? BigInt(inv.rows[0].available_atomic) : 0n;
    const reserved = inv.rows[0] ? BigInt(inv.rows[0].reserved_atomic) : 0n;

    if (reserved < amountAtomic) throw new Error("내부 재고(예약)가 부족합니다. 관리자에게 문의하세요.");
    if (available < sendAtomic) {
      await alert("inventory_low", `${symbol} 지갑 재고 부족(송금 요청).`, {
        symbol,
        available: available.toString(),
        required_send: sendAtomic.toString(),
      });
      throw new Error("현재 지갑 재고가 부족합니다(관리자 처리 필요).");
    }

    await tx`
      UPDATE coin_inventory
      SET
        reserved_atomic = reserved_atomic - ${pgBigint(amountAtomic)}::bigint,
        available_atomic = available_atomic - ${pgBigint(sendAtomic)}::bigint,
        updated_at = now()
      WHERE symbol = ${symbol}
    `;

    const created = await tx<{ id: string }>`
      INSERT INTO transfer_requests (
        discord_id, symbol, to_address, coin_amount_atomic, fee_coin_atomic, unit_scale, status
      )
      VALUES (
        ${pgBigint(discordId)}::bigint,
        ${symbol},
        ${to},
        ${pgBigint(sendAtomic)}::bigint,
        ${pgBigint(feeAtomic)}::bigint,
        ${Number(unitScale)},
        'requested'
      )
      RETURNING id::text AS id
    `;

    await tx`
      INSERT INTO admin_alerts (kind, message, context)
      VALUES (
        'transfer_requested',
        ${`${symbol} 송금 요청: ${sendAtomic.toString()} (fee ${feeAtomic.toString()})`},
        ${pgJson({
          discordId: discordId.toString(),
          symbol,
          to,
          sendAtomic: sendAtomic.toString(),
          feeAtomic: feeAtomic.toString(),
          transferId: created.rows[0].id,
        })}::jsonb
      )
    `;

    return created.rows[0].id;
  });

  await alert("transfer_requested", `${symbol} 송금 요청 생성됨: ${transferId}`, {
    transferId,
    discordId: discordId.toString(),
    symbol,
    to,
    sendAtomic: sendAtomic.toString(),
    feeAtomic: feeAtomic.toString(),
  });

  return message(
    [
      "✅ 송금 요청이 접수되었습니다(서버리스 환경: **자동 브로드캐스트는 별도 지갑 서비스 연동 필요**).",
      `- 코인: **${symbol}**`,
      `- 수신지: \`${to}\``,
      `- 요청 수량: \`${formatAtomicToDecimal(amountAtomic, unitScale)}\``,
      `- 수수료: \`${formatAtomicToDecimal(feeAtomic, unitScale)}\``,
      `- 실제 전송: \`${formatAtomicToDecimal(sendAtomic, unitScale)}\``,
      `- 요청 ID: \`${transferId}\``,
      "",
      "관리자가 TX 해시를 등록하면 상태가 갱신됩니다.",
    ].join("\n"),
    { ephemeral: true }
  );
}

async function cmdAdminSetTx(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  const id = String(getOptionValue(i, "transfer_id") ?? "").trim();
  const txHash = String(getOptionValue(i, "tx_hash") ?? "").trim();
  const status = String(getOptionValue(i, "status") ?? "").trim();
  if (!id) return errorMessage("transfer_id가 필요합니다.");
  if (!status) return errorMessage("status가 필요합니다.");

  const allowed = new Set(["broadcasted", "confirmed", "failed", "cancelled"]);
  if (!allowed.has(status)) return errorMessage("status는 broadcasted/confirmed/failed/cancelled 중 하나여야 합니다.");

  await sql`
    UPDATE transfer_requests
    SET
      tx_hash = ${txHash || null},
      status = ${status}::transfer_status,
      updated_at = now()
    WHERE id = ${id}::uuid
  `;

  return message(`✅ transfer ${id} 상태를 ${status} 로 업데이트했습니다.`, { ephemeral: true });
}

async function cmdAdminSetStock(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  const symbol = coinChoiceOrThrow(getOptionValue(i, "symbol"));
  const availableStr = String(getOptionValue(i, "available") ?? "").trim();
  const suspendedOpt = getOptionValue(i, "suspended");
  if (!availableStr) return errorMessage("available(수량)이 필요합니다.");

  const unitScale = COIN_UNIT_SCALE[symbol];
  const availableAtomic = parseDecimalToInt(availableStr, unitScale);
  if (availableAtomic < 0n) return errorMessage("available은 0 이상이어야 합니다.");

  await sql`
    INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
    VALUES (${symbol}, ${pgBigint(availableAtomic)}::bigint, 0, ${Boolean(suspendedOpt)})
    ON CONFLICT (symbol) DO UPDATE SET
      available_atomic = EXCLUDED.available_atomic,
      suspended = EXCLUDED.suspended,
      updated_at = now()
  `;

  await alert("admin_stock_update", `${symbol} 재고 업데이트: ${availableAtomic.toString()} atomic`, {
    symbol,
    availableAtomic: availableAtomic.toString(),
    suspended: Boolean(suspendedOpt),
  });

  return message(
    `✅ ${symbol} available_atomic = ${availableAtomic.toString()} (≈ ${formatAtomicToDecimal(
      availableAtomic,
      unitScale
    )}) 로 설정했습니다.`,
    { ephemeral: true }
  );
}

