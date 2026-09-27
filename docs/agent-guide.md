[README](../README.md) · [How the companion works](how-it-works.md)

# DearByte agent — Setup and testing guide

This guide covers the personal agent: health, calendar, caution alerts and the morning brief, Telegram, the company watchlist, money, the testnet wallet, and talking to it in WeChat or iMessage. For 小拜, the Chinese companion, see the [operations guide](guide.en.md).

**Status (2026-09-27):** all of Phase 1 is on `master`, and 319 offline tests pass. Run live so far:
- real Apple Watch data and the Mac's calendar;
- a real Telegram bot;
- watchlist screening on real feeds;
- MindGo money (read-only);
- Claude Opus as the brain with DeepSeek as the worker;
- the agent in WeChat, in Mandarin;
- the wallet's full flow on chain: approved in Telegram, then 0.05 test USDC paid on Base Sepolia.

Still to test live: iMessage. The [checklist](#live-test-checklist) below covers each part.

## Setup, in order

Each step works without the ones after it. Run `npm run dearbyte -- status` at any point to see which models, tools and limits are active.

| Step | What you do | Result |
| --- | --- | --- |
| 1. Models | `DEEPSEEK_API_KEY` in `.env` (optionally `ANTHROPIC_API_KEY` and `DEARBYTE_BRAIN=anthropic:claude-opus-5-5`) | `ask` and `chat` work |
| 2. Calendar (macOS) | `npm run dearbyte -- calendar` and allow access when macOS asks | Today's events in the brief; a caution when a hard day follows a bad night |
| 3. Health | Install the [dearbyte-bridge](https://github.com/dearbyte-labs/dearbyte-bridge) iPhone app and Worker; put the MCP address in `HEALTH_MCP_URL` | Sleep, heart rate and HRV tools; the brief and caution alerts |
| 4. Telegram | Create a bot with @BotFather; see [Telegram](../README.md#telegram) | Alerts and approvals reach you away from the terminal |
| 5. Watchlist | Copy `watchlist.example.json` to `watchlist.json`; optionally set `SEC_CONTACT_EMAIL` | Company news, screened against your interests |
| 6. Money | Copy `finance.example.json` to `finance.json` and put in your numbers. Optionally connect MindGo: in MindGo's `backend/`, `npm run access-token -- create <email> DearByte`, then set `MINDGO_MCP_URL` and `MINDGO_TOKEN` | `npm run dearbyte -- fire`, and the agent can answer "when could I retire?". With MindGo, the plan uses your last 12 months of spending and saving, the agent can answer "how am I doing this term?", and the brief flags spending ahead of pace or an overdue goal |
| 7. Wallet | `npm run dearbyte -- wallet new`, then test USDC from [Circle's faucet](https://faucet.circle.com) (Base Sepolia); set `DEARBYTE_SELLERS` | The agent can propose purchases, and you approve them |
| 8. Chat apps (optional) | **WeChat:** the companion's WeChat setup ([operations guide](guide.en.md)), then `npm run dearbyte -- wechat`. **iMessage:** Messages signed in on the Mac (a separate Apple ID for DearByte looks best), Full Disk Access for the terminal, `DEARBYTE_IMESSAGE_TO` set to your number, then `npm run dearbyte -- imessage -m` or `-e` | Talk to the agent from your phone. Approve a purchase by replying yes (好) or no (算了) |

Secrets (`HEALTH_MCP_URL`, `MINDGO_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DEARBYTE_WALLET_KEY`, API keys) go only in `.env`, which Git ignores. Never paste them into chat, issues, commits or screenshots. `wallet new` prints only the address, never the key.

## The demo

```bash
npm run demo                 # each part uses your real setup when it exists, sample data when it doesn't
npm run demo -- --sample     # sample data everywhere: a rehearsal that never depends on your setup
npm run demo -- --testnet    # pay on Base Sepolia for real (needs DEARBYTE_WALLET_KEY with test USDC, and SELLER_PAY_TO)
npm run demo -- --no-pause   # don't wait for Enter between parts
```

The demo runs three parts, pausing between them:
1. **Knows you:** the morning brief with today's calendar, then a question about the day, answered with the health and calendar tools.
2. **Watches for you:** one watchlist check. The worker screens each item and says why; the brain writes the message.
3. **Spends for you:** the agent proposes buying a recovery plan from the example seller, which the demo starts on port 4029. You approve by typing yes, or with the button in Telegram. It pays and prints the receipt, then the agent tells you what it bought.

Without your own setup, a part uses sample data, and says so on screen and in Telegram:
- health: a made-up week of about 7 hours a night, then a 5h10m night;
- calendar: a made-up day with a standup at 10:00 and leg day in the evening;
- news: the newsroom of a made-up company;
- payment: the seller in dev mode, which checks the signed payment but moves nothing on chain.

The demo records everything in `data/demo.sqlite`, recreated on each run, so your real alerts, news history and receipts are untouched, and a second take isn't blocked by the daily limits. Model spending still goes in the usage log and counts toward the weekly cap: a run costs about $0.005 on DeepSeek.

Two exceptions and one caution:
- With `--testnet`, purchases and their receipts go to your real database, so real test spending counts toward your daily limit.
- `--sample` doesn't read your real memory either.
- If Telegram is set up, stop `npm run dearbyte -- watch` while the demo runs. Otherwise both would answer the same button taps. The demo ignores taps left over from earlier runs.

## Commands

```bash
npm run dearbyte -- ask "How did I sleep?"   # answer one question
npm run dearbyte -- chat                     # talk until /quit; /approve N works here
npm run dearbyte -- status                   # models, tools, limits, spending, alert ratings
npm run dearbyte -- brief [--force]          # send the morning brief now
npm run dearbyte -- check                    # run the caution rules once
npm run dearbyte -- watch                    # keep running (see below)
npm run dearbyte -- alerts                   # recent briefs and alerts
npm run dearbyte -- telegram                 # set up Telegram, or send a test approval
npm run dearbyte -- calendar                 # allow calendar access; list the next 48 hours
npm run dearbyte -- news                     # check the company watchlist once
npm run dearbyte -- fire [--retire 45 ...]   # your FIRE plan; what-ifs: --retire --spend --save --assets --lifespan --return --inflation (percent)
npm run dearbyte -- wallet [new]             # address, balance, limits, recent purchases
npm run dearbyte -- approvals                # requests waiting for your yes
npm run dearbyte -- approve N | reject N     # answer one in the terminal
npm run dearbyte -- wechat [--draft]         # the agent in WeChat, in Mandarin as 小拜
npm run dearbyte -- imessage -m|-e [--to <handle>] [--draft]   # the agent in iMessage: Mandarin or English
npm run dearbyte -- help                     # every command
npm run seller [-- --dev]                 # the example x402 seller on http://127.0.0.1:4021
npm run demo                              # the three-part demo (see above)
npm run agent:usage                       # what every model call cost
```

`watch` is DearByte's always-on mode. While it runs:
- the morning brief goes out after 07:30;
- the caution rules run every 15 minutes, and the watchlist is checked every hour;
- Telegram button taps (👍/👎, Approve/Reject) are handled.

Nothing is sent in quiet hours (23:00–07:00). DearByte sends at most 3 caution alerts and at most 3 news messages a day, and model spending counts toward `DEARBYTE_WEEKLY_CAP`. Run only one `watch` at a time: two would each answer taps and send alerts.

## Where things are stored

Everything is in `data/companion.sqlite` (Git-ignored):

| Table | What |
| --- | --- |
| `health_daily` | One summary per day (sleep, resting heart rate, HRV), used for your 14-day baseline |
| `agent_alerts` | Every brief and alert DearByte sent on its own, with your 👍/👎 |
| `approvals` | Approval requests: pending, approved, rejected or expired |
| `watch_items` | News items seen, with the model's verdict and whether they were sent |
| `purchases` | Wallet receipts: paid, unconfirmed or failed, with the transaction link |
| `agent_usage` | Every model call with its tokens and price |

## Live test checklist

Run these once each part is set up. Each should take a few minutes.

**Health (needs `HEALTH_MCP_URL`)**
- [ ] `npm run dearbyte -- ask "How did I sleep last night?"` gives numbers that match the Health app.
- [ ] `npm run dearbyte -- brief --force` writes a brief that compares last night with your normal. Until a few nights are stored, sleep is compared with a default 7 hours.
- [ ] `npm run dearbyte -- check` either sends nothing or gives a reason you agree with.

**Calendar (macOS)**
- [ ] `npm run dearbyte -- calendar` lists the same events as the Calendar app on your iPhone, minus what DearByte leaves out on purpose: cancelled events, invites you declined or haven't answered, and subscribed calendars (holidays, birthdays, sports fixtures). If your own events are missing, those calendars are probably "On My iPhone" rather than iCloud.
- [ ] `npm run dearbyte -- ask "What's on my calendar today?"` answers from it.
- [ ] After a short night with training on the calendar, `check` names the event in its reason ("hard event").

**Telegram (needs the bot token and chat id)**
- [ ] `npm run dearbyte -- telegram` sends a test approval, and tapping a button answers it.
- [ ] With `watch` running, `brief --force` arrives in Telegram with 👍/👎, and the tap shows up in `status`.
- [ ] A message from another Telegram account to the bot is ignored.

**Watchlist (needs `watchlist.json`)**
- [ ] `npm run dearbyte -- news` lists what it found and why each item was kept or skipped.
- [ ] Running it again right away sends nothing new.
- [ ] In `chat`, "anything new on Meta?" answers from what was collected, with links.

**MindGo (needs `MINDGO_MCP_URL` and `MINDGO_TOKEN`)**
- [ ] `npm run dearbyte -- status` says "MindGo connected".
- [ ] `npm run dearbyte -- fire` says its monthly numbers come from MindGo, and they match MindGo's dashboard averages.
- [ ] `npm run dearbyte -- ask "How am I doing on money this term?"` names this term's totals and the term it compares pace with.
- [ ] Revoke the token in MindGo (`npm run access-token -- revoke <email> <id>`); `ask` then explains that MindGo refused the token.

**Wallet on testnet (needs faucet USDC)**
- [ ] `npm run dearbyte -- wallet` shows the address and a USDC balance.
- [ ] Start the seller for real: `SELLER_PAY_TO=<a second address you control> npm run seller`.
- [ ] In `chat` (with `DEARBYTE_SELLERS=http://127.0.0.1:4021`), ask for the recovery plan. Approve it, and check that the receipt says **paid** and links a Base Sepolia transaction.
- [ ] Ask for something over `DEARBYTE_MAX_PURCHASE`. It should be refused, with nothing proposed.
- [ ] Reject a proposal. Nothing should be paid.

**WeChat (needs the companion's WeChat setup)**
- [ ] `npm run dearbyte -- wechat --draft` prints a Mandarin reply to 「我昨晚睡得如何」 with real numbers, and sends nothing.
- [ ] Without `--draft`, ask it to buy the recovery plan. Code's request bubble appears; 「好」 approves it and 「算了」 rejects it.

**iMessage (needs Full Disk Access and `DEARBYTE_IMESSAGE_TO`)**
- [ ] `npm run dearbyte -- imessage -e --draft` prints "Connected", then drafts an English reply to your next text.
- [ ] Without `--draft`, the reply arrives on your phone and isn't answered again when it echoes back.
- [ ] With `-m`, the reply is in Mandarin as 小拜.

**Claude as the brain (optional, needs `ANTHROPIC_API_KEY`)**
- [ ] `DEARBYTE_BRAIN=anthropic:claude-opus-5-5 npm run dearbyte -- brief --force` works, and its cost shows in `npm run agent:usage`.

## The FIRE plan

`finance.json` holds your age, when you'd like to stop working, what you own (`netAssets`), and what you save and spend each month, in one currency. Returns (7%), inflation (3%), lifespan (90) and the withdrawal rate (4%) have defaults you can change. Everything is computed in today's money:

- **4% rule number:** 25 years of spending, meant to last indefinitely.
- **Die-with-zero number:** just enough at your retirement age to keep spending the same until your lifespan, drawing the principal down to nothing. It is smaller than the 4% number and depends on the lifespan, so keep that generous.
- **Coast number:** with this much today, you could stop saving and still reach the die-with-zero number by your retirement age.
- **Earliest retirement age, the most you could spend in retirement, and net worth by age,** plus how much more to save when the plan runs short.

Ask what-ifs in the terminal (`npm run dearbyte -- fire --retire 45 --return 5`) or in chat ("what if I retire at 45?"). The agent calls `fire_plan` with the change, and code does the math. It talks about budgets, saving and what the numbers mean, never specific investments.

## Code layout

```text
src/main.ts             npm run dearbyte: a command goes to the agent, none to the companion
src/agent-cli.ts        the agent's commands
src/agent/              agent loop, validated tools, model tiers, usage log, approvals, scheduled brief and alerts
src/agent/messaging.ts  the agent in a chat app: bubbles, history, yes/no approvals, Chinese or English
src/channels/           the reply loop, WeChat for Mac (desktop/) and iMessage (imessage/)
src/health/             bridge MCP client, daily snapshots and baseline, caution rules
src/calendar/           the Mac's calendars (EventKit helper in native/calendar), the get_calendar tool, the hard-event rule
src/telegram/           Bot API client (long polling) and the handler for button taps
src/watchlist/          newsroom and SEC sources, screening, news tools
src/finance/            FIRE math (fire.ts), finance.json, the fire_plan tool, the terminal report, and the MindGo client (mindgo.ts)
src/wallet/             limits, x402 quote and payment, purchase proposals and receipts
examples/seller/        example x402 seller (moving to its own repo)
personas/               persona packs (docs/personas.md); INDEX.md is generated
prompts/agent/          the rules every persona gets
```
