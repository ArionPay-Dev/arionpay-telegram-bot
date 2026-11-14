#!/usr/bin/env node
// ArionPay Telegram shop bot: sell digital items in Telegram, paid in crypto straight to your own wallet.
//
//   cp .env.example .env    (fill it in)      node bot.mjs
//
// Customers: /start shows the products, a button creates an ArionPay invoice and opens the payment page.
// When ArionPay confirms the payment, the bot sends the item ("deliver" text in products.json).
// Payment updates arrive by signed webhook when PUBLIC_URL is set, otherwise the bot asks ArionPay every 30 s.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ArionPay, ArionPaySignatureError, isTestEvent } from "arionpay";

// ------------------------------------------------------------------ settings
function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(process.env.ENV_FILE ?? ".env");
const env = process.env;
const need = (k) => {
  if (!env[k]) {
    console.error(`Missing ${k} (see .env.example)`);
    process.exit(1);
  }
  return env[k];
};
const TELEGRAM_TOKEN = need("TELEGRAM_BOT_TOKEN");
const TELEGRAM_API = (env.TELEGRAM_API_URL ?? "https://api.telegram.org").replace(/\/+$/, "");
const TEST_MODE = (env.ARIONPAY_TEST_MODE ?? "true") !== "false";
const PUBLIC_URL = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
const PORT = Number(env.PORT ?? 8080);
const DATA_FILE = env.DATA_FILE ?? "orders.json";
const PRODUCTS = JSON.parse(readFileSync(env.PRODUCTS_FILE ?? "products.json", "utf8"));
const POLL_MS = Number(env.POLL_SECONDS ?? 30) * 1000;
const arionpay = new ArionPay({
  apiKey: need("ARIONPAY_API_KEY"),
  apiSecret: need("ARIONPAY_API_SECRET"),
  webhookSecret: env.ARIONPAY_WEBHOOK_SECRET ?? "",
  baseUrl: env.ARIONPAY_BASE_URL || undefined,
  appInfo: "arionpay-telegram-bot/1.0.0",
});
if (PUBLIC_URL && !env.ARIONPAY_WEBHOOK_SECRET) {
  console.error("PUBLIC_URL is set, so ARIONPAY_WEBHOOK_SECRET is needed to check the webhooks.");
  process.exit(1);
}

// ------------------------------------------------------------------ orders (a small JSON file)
/** @type {{ orders: Record<string, any>, events: string[], offset: number }} */
const db = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf8")) : { orders: {}, events: [], offset: 0 };
function save() {
  writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2));
  renameSync(DATA_FILE + ".tmp", DATA_FILE);
}

// ------------------------------------------------------------------ Telegram
async function tg(method, body) {
  const r = await fetch(`${TELEGRAM_API}/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}
const say = (chatId, text, extra = {}) => tg("sendMessage", { chat_id: chatId, text, ...extra }).catch((e) => console.error(e.message));
const money = (p) => `${p.price} ${p.currency}`;

async function showCatalog(chatId) {
  const rows = PRODUCTS.map((p) => [{ text: `${p.name} · ${money(p)}`, callback_data: `buy:${p.id}` }]);
  await say(chatId, `${env.SHOP_WELCOME ?? "Welcome! Choose what you want to buy. You pay with Bitcoin, USDT and more."}${TEST_MODE ? "\n\n(Test mode: no real money is taken.)" : ""}`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function buy(chatId, productId) {
  const p = PRODUCTS.find((x) => x.id === productId);
  if (!p) return say(chatId, "Sorry, that item is not available any more. Send /start to see the list.");
  const orderId = `tg-${randomBytes(6).toString("hex")}`;
  try {
    const invoice = await arionpay.createInvoice({
      amount: String(p.price),
      currency: p.currency,
      orderId,
      description: p.name,
      callbackUrl: PUBLIC_URL ? `${PUBLIC_URL}/arionpay/webhook` : undefined,
      metadata: { telegram_chat_id: chatId, product_id: p.id, platform: "telegram-bot" },
      idempotencyKey: orderId,
      test: TEST_MODE,
    });
    db.orders[invoice.id] = { orderId, chatId, productId: p.id, price: String(p.price), currency: p.currency, status: "new", delivered: false, created: Date.now() };
    save();
    await say(chatId, `${p.name}: ${money(p)}\nPress the button to pay with crypto. The link works for a limited time.`, {
      reply_markup: { inline_keyboard: [[{ text: `Pay ${money(p)}`, url: invoice.invoiceUrl }]] },
    });
  } catch (e) {
    console.error("createInvoice failed:", e.message);
    await say(chatId, "The payment could not be started right now. Please try again in a minute.");
  }
}

// ------------------------------------------------------------------ payment updates (same handling for webhook and polling)
/**
 * @param {string} invoiceId
 * @param {string} type invoice.pending | invoice.partial | invoice.paid | invoice.expired | invoice.needs_review
 * @param {any} invoice the verified invoice (webhook data.invoice or getInvoice())
 */
async function onUpdate(invoiceId, type, invoice) {
  const o = db.orders[invoiceId];
  if (!o) return "unknown";
  // a test invoice must never deliver in live mode, nor a live one in test mode
  if (Boolean(invoice.test) !== TEST_MODE) return "mode_mismatch";
  if (type === "invoice.paid") {
    if (o.delivered) return "duplicate";
    const p = PRODUCTS.find((x) => x.id === o.productId);
    const same = Number(invoice.amountFiat).toFixed(2) === Number(o.price).toFixed(2) && String(invoice.currency).toUpperCase() === o.currency.toUpperCase();
    if (!p || !same) {
      o.status = "check_by_hand";
      save();
      await say(o.chatId, "Your payment arrived, but something does not match the order. The seller will check it and contact you.");
      return "mismatch";
    }
    o.status = "paid";
    o.delivered = true;
    o.paidAt = Date.now();
    save();
    await say(o.chatId, `Payment received, thank you!${invoice.test ? " (test)" : ""}\n\n${p.name}:\n${p.deliver}`);
    return "delivered";
  }
  if (o.delivered) return "ignored";
  if (type === "invoice.pending" && o.status !== "pending") {
    o.status = "pending";
    save();
    await say(o.chatId, "We see your payment on the network. It is waiting for confirmations; you will get your item as soon as it is confirmed.");
  } else if (type === "invoice.expired" && o.status !== "expired") {
    o.status = "expired";
    save();
    await say(o.chatId, "The payment time ran out. If you already paid, wait: a late payment is still detected. Otherwise send /start to try again.");
  }
  return "ok";
}

// ------------------------------------------------------------------ webhook server (when PUBLIC_URL is set) and health
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return res.writeHead(200).end("ok");
  if (req.method !== "POST" || req.url !== "/arionpay/webhook") return res.writeHead(404).end();
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 262144) req.destroy();
    else chunks.push(c);
  });
  req.on("end", async () => {
    let event;
    try {
      event = arionpay.verifyWebhook(Buffer.concat(chunks), req.headers["arionpay-signature"]);
    } catch (e) {
      if (!(e instanceof ArionPaySignatureError)) console.error(e);
      return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_signature"}');
    }
    if (isTestEvent(event)) return res.writeHead(200, { "content-type": "application/json" }).end('{"received":true,"test_event":true}');
    if (db.events.includes(event.id)) return res.writeHead(200, { "content-type": "application/json" }).end('{"received":true,"duplicate":true}');
    const inv = event.data.invoice;
    const meta = inv.metadata ?? {};
    const o = db.orders[inv.id];
    if (o && (String(meta.telegram_chat_id) !== String(o.chatId) || inv.orderId !== o.orderId)) {
      return res.writeHead(409, { "content-type": "application/json" }).end('{"error":"invoice_order_mismatch"}');
    }
    const result = await onUpdate(inv.id, event.type, inv).catch((e) => (console.error(e), "error"));
    if (result === "error") return res.writeHead(503).end();
    if (result === "mode_mismatch") return res.writeHead(409, { "content-type": "application/json" }).end('{"error":"test_live_mismatch"}');
    db.events = [...db.events.slice(-500), event.id];
    save();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true, result }));
  });
});

// ------------------------------------------------------------------ polling ArionPay (when there is no PUBLIC_URL)
async function pollOpenOrders() {
  const open = Object.entries(db.orders).filter(([, o]) => !o.delivered && o.status !== "check_by_hand" && Date.now() - o.created < 3 * 86400_000);
  for (const [invoiceId, o] of open) {
    try {
      const inv = await arionpay.getInvoice(invoiceId);
      const type = inv.status === "paid" ? "invoice.paid" : inv.status === "pending" ? "invoice.pending" : inv.status === "expired" ? "invoice.expired" : null;
      if (type && (type === "invoice.paid" || o.status !== inv.status)) await onUpdate(invoiceId, type, inv);
    } catch (e) {
      console.error(`poll ${invoiceId}:`, e.message);
    }
  }
}

// ------------------------------------------------------------------ Telegram long polling
async function telegramLoop() {
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset: db.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        db.offset = u.update_id + 1;
        if (u.message?.text?.startsWith("/start")) await showCatalog(u.message.chat.id);
        else if (u.message?.text?.startsWith("/buy ")) await buy(u.message.chat.id, u.message.text.slice(5).trim());
        else if (u.callback_query?.data?.startsWith("buy:")) {
          await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
          await buy(u.callback_query.message.chat.id, u.callback_query.data.slice(4));
        }
      }
      if (updates.length) save();
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

server.listen(PORT, env.HOST ?? "0.0.0.0", () => {
  console.log(`ArionPay Telegram bot running (${TEST_MODE ? "TEST mode" : "live"}); ${PUBLIC_URL ? `webhooks at ${PUBLIC_URL}/arionpay/webhook` : `checking open orders every ${POLL_MS / 1000} s`}`);
});
if (!PUBLIC_URL) setInterval(() => void pollOpenOrders(), POLL_MS);
telegramLoop();
