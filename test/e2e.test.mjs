// Runs the bot against a fake Telegram API and a real ArionPay server (sandbox), in webhook and in polling mode.
//   ARIONPAY_IT_BASE_URL=http://127.0.0.1:18090 ARIONPAY_IT_API_KEY=pk_... ARIONPAY_IT_API_SECRET=sk_... \
//   ARIONPAY_IT_WEBHOOK_SECRET=whsec_... node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { ArionPay } from "arionpay";

const env = process.env;
const skip = !env.ARIONPAY_IT_BASE_URL && "set ARIONPAY_IT_BASE_URL to run against a real server";
const BOT = new URL("../bot.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny Telegram Bot API: queued updates for getUpdates, every sendMessage recorded. */
function fakeTelegram(port) {
  const updates = [];
  const sent = [];
  let nextId = 1;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const method = req.url.split("/").pop();
      const reply = (result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      if (method === "getUpdates") {
        for (let i = 0; i < 20 && !updates.some((u) => u.update_id >= (body.offset ?? 0)); i++) await sleep(100);
        return reply(updates.filter((u) => u.update_id >= (body.offset ?? 0)));
      }
      if (method === "sendMessage") {
        sent.push(body);
        return reply({ message_id: sent.length, chat: { id: body.chat_id }, text: body.text });
      }
      return reply(true);
    });
  }).listen(port, "127.0.0.1");
  return {
    server,
    sent,
    text: (chatId, text) => updates.push({ update_id: nextId++, message: { message_id: nextId, chat: { id: chatId }, text } }),
    press: (chatId, data) => updates.push({ update_id: nextId++, callback_query: { id: String(nextId), data, message: { message_id: 1, chat: { id: chatId } } } }),
  };
}

async function waitFor(fn, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error("timed out");
}

async function run(mode) {
  const tgPort = mode === "webhook" ? 18410 : 18420;
  const botPort = tgPort + 1;
  const tgApi = fakeTelegram(tgPort);
  const dir = mkdtempSync(join(tmpdir(), "arionpay-bot-"));
  writeFileSync(join(dir, "products.json"), JSON.stringify([{ id: "ebook", name: "Test eBook", price: "9.90", currency: "USD", deliver: "SECRET-DOWNLOAD-LINK" }]));
  const child = spawn(process.execPath, [BOT], {
    cwd: dir,
    env: {
      ...process.env,
      ENV_FILE: "/nonexistent",
      TELEGRAM_BOT_TOKEN: "123:test",
      TELEGRAM_API_URL: `http://127.0.0.1:${tgPort}`,
      ARIONPAY_API_KEY: env.ARIONPAY_IT_API_KEY,
      ARIONPAY_API_SECRET: env.ARIONPAY_IT_API_SECRET,
      ARIONPAY_WEBHOOK_SECRET: env.ARIONPAY_IT_WEBHOOK_SECRET,
      ARIONPAY_BASE_URL: env.ARIONPAY_IT_BASE_URL,
      ARIONPAY_TEST_MODE: "true",
      PUBLIC_URL: mode === "webhook" ? `http://127.0.0.1:${botPort}` : "",
      PORT: String(botPort),
      HOST: "127.0.0.1",
      POLL_SECONDS: "2",
      NODE_PATH: new URL("../node_modules", import.meta.url).pathname,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const ap = new ArionPay({ apiKey: env.ARIONPAY_IT_API_KEY, apiSecret: env.ARIONPAY_IT_API_SECRET, baseUrl: env.ARIONPAY_IT_BASE_URL });
  try {
    await waitFor(() => log.includes("running"));
    const chat = 4242;
    tgApi.text(chat, "/start");
    const catalog = await waitFor(() => tgApi.sent.find((m) => m.chat_id === chat && m.reply_markup?.inline_keyboard));
    assert.match(catalog.text, /Test mode/);
    assert.equal(catalog.reply_markup.inline_keyboard[0][0].callback_data, "buy:ebook");

    tgApi.press(chat, "buy:ebook");
    const payMsg = await waitFor(() => tgApi.sent.find((m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.url));
    const url = payMsg.reply_markup.inline_keyboard[0][0].url;
    const invoiceId = url.split("/").pop();
    const inv = await ap.getInvoice(invoiceId);
    assert.equal(inv.amountFiat, 9.9);
    assert.equal(inv.test, true);
    assert.equal(tgApi.sent.some((m) => /SECRET-DOWNLOAD-LINK/.test(m.text)), false, "nothing delivered before payment");

    await fetch(`${env.ARIONPAY_IT_BASE_URL}/api/public/invoice/${invoiceId}/asset`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset: "USDT_TRC20" }) });
    await ap.simulatePayment(invoiceId, "exact");
    const delivered = await waitFor(() => tgApi.sent.find((m) => /SECRET-DOWNLOAD-LINK/.test(m.text)));
    assert.match(delivered.text, /Payment received/);

    if (mode === "webhook") {
      const hook = `http://127.0.0.1:${botPort}/arionpay/webhook`;
      const raw = JSON.stringify({ id: "evt_forged", type: "invoice.paid", data: { invoice: { id: invoiceId, test: true, amountFiat: 9.9, currency: "USD" } } });
      const t = Math.floor(Date.now() / 1000);
      let r = await fetch(hook, { method: "POST", body: raw, headers: { "ArionPay-Signature": `t=${t},v1=${createHmac("sha256", "whsec_wrong").update(`${t}.${raw}`).digest("hex")}` } });
      assert.equal(r.status, 401, "forged webhook refused");
      const raw2 = JSON.stringify({ id: "evt_again", type: "invoice.paid", data: { invoice: { ...(await ap.getInvoice(invoiceId)), id: invoiceId, orderId: inv.orderId, metadata: { telegram_chat_id: chat } } } });
      r = await fetch(hook, { method: "POST", body: raw2, headers: { "ArionPay-Signature": `t=${t},v1=${createHmac("sha256", env.ARIONPAY_IT_WEBHOOK_SECRET).update(`${t}.${raw2}`).digest("hex")}` } });
      assert.equal(r.status, 200);
      await sleep(500);
      assert.equal(tgApi.sent.filter((m) => /SECRET-DOWNLOAD-LINK/.test(m.text)).length, 1, "delivered once");
    } else {
      await sleep(5000);
      assert.equal(tgApi.sent.filter((m) => /SECRET-DOWNLOAD-LINK/.test(m.text)).length, 1, "delivered once");
    }
  } finally {
    child.kill();
    tgApi.server.close();
  }
}

test("webhook mode: browse, buy, pay in the sandbox, item delivered once", { skip, timeout: 120000 }, () => run("webhook"));
test("polling mode (no public address): same flow", { skip, timeout: 120000 }, () => run("polling"));
