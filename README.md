# ArionPay Telegram shop bot

Sell digital items in Telegram (files, links, licence keys, private-group invites) and get paid in Bitcoin, USDT, Litecoin, Ethereum, TRON and more through [ArionPay](https://arionpay.com). The money goes straight to your own wallet.

- Customers send `/start`, tap an item, and pay on the secure ArionPay page.
- When ArionPay confirms the payment, the bot sends the item. Each order is delivered once.
- No database or framework: one file, Node.js 18 or newer.
- Runs anywhere. With a public `https` address it gets instant signed webhooks; without one it asks ArionPay about open orders every 30 seconds.

Tested against a real ArionPay server in both modes: browse, buy, sandbox payment, delivery once, forged webhook refused.

## Set up (10 minutes)

1. In Telegram, talk to **@BotFather**, send `/newbot` and copy the bot token.
2. In your ArionPay dashboard, open your store and copy the **API key** (`pk_...`) and **API secret** (`sk_...`).
3. On your server or computer:

   ```bash
   git clone <this repository> arionpay-telegram-bot && cd arionpay-telegram-bot
   npm install
   cp .env.example .env      # paste the token and keys
   ```

4. Edit `products.json`: one entry per item, with what the bot sends after payment in `deliver`:

   ```json
   [
     { "id": "ebook", "name": "Crypto Basics eBook", "price": "9.90", "currency": "USD", "deliver": "Download: https://example.com/files/crypto-basics.pdf" }
   ]
   ```

5. Start it: `npm start`. Send `/start` to your bot and buy something. In test mode, finish the payment with the test buttons on the ArionPay page; no real money moves.
6. When everything works, set `ARIONPAY_TEST_MODE=false` and restart.

## Instant updates (optional)

If the bot runs on a server with a public `https` address (for example behind nginx), set:

```
PUBLIC_URL=https://bot.example.com
ARIONPAY_WEBHOOK_SECRET=whsec_...   # ArionPay dashboard > Webhooks > signing secret
```

The bot then listens on `PORT` (default 8080) at `/arionpay/webhook` and every invoice tells ArionPay to send its updates there. Without `PUBLIC_URL` the bot checks open orders every `POLL_SECONDS` (default 30).

## What customers see

| Moment | Message |
| --- | --- |
| `/start` | The product list as buttons. |
| Tap an item | A **Pay 9.90 USD** button to the ArionPay page. |
| Payment seen on the network | "We see your payment… waiting for confirmations." |
| Payment confirmed | "Payment received, thank you!" and the item. |
| Time ran out | "The payment time ran out… send /start to try again." |

## Good to know

- Orders are kept in `orders.json` next to the bot. Back it up.
- An item is sent only when ArionPay confirms the full payment for that order, in the same currency and amount. A payment that is not exact goes to **Payment Radar** in your ArionPay dashboard, where you decide; if you accept it, the bot delivers.
- A test invoice never delivers while the bot is in live mode, and a live one never in test mode.
- The bot sends ArionPay only the item name, price and an order number, plus the Telegram chat id in the invoice data so the right person gets the item.
