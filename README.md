# Expenses — personal expense manager

A home-screen app for logging spends by hand: amount, category, UPI/Card/Cash and an optional note.
It shows this month against your budgets, a month-end summary in plain words, and lets you download everything as a CSV.

## How it fits together

| Piece | What it is | Why |
|---|---|---|
| `index.html` | The app you open on your phone. Hosted free on GitHub Pages. | The code is public, but it holds **no expenses** — only the screens. |
| `worker/index.js` | A small server on your Cloudflare account. | It receives each expense when you tap Save and keeps it. |
| The Store | A private SQLite database inside that server (a "Durable Object"). | This is where your expenses actually live. Only reachable through the server, and only with your PIN. |
| PIN | A secret you choose, saved in GitHub Secrets and handed to Cloudflare. | Every request must carry it. 8 wrong tries locks the server for 15 minutes. |
| `.github/workflows/deploy-worker.yml` | An automatic job on GitHub. | Whenever the server code changes, it sends the new version to Cloudflare for you. |

## One-time setup

1. **Add three secrets** — GitHub → this repo → Settings → Secrets and variables → Actions → *New repository secret*:
   - `CLOUDFLARE_API_TOKEN` — the same kind of token the desk ticker uses (Cloudflare → My Profile → API Tokens → template **Edit Cloudflare Workers**).
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages → right-hand side, *Account ID*.
   - `EXPENSE_PIN` — any PIN you like (6+ digits recommended).
2. **Deploy the server** — Actions tab → *Deploy server to Cloudflare* → *Run workflow*. When it turns green, its log shows the server address, like `https://expense-manager.<your-subdomain>.workers.dev`.
3. **Turn on the app page** — Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)` → Save. After a minute the app is at `https://2mintrails.github.io/expense-manager/`.
4. **On your iPhone** — open that page in Safari → Share → *Add to Home Screen*. Open it, paste the server address from step 2, enter your PIN → Connect.

## Everyday use

- **Add** — type the amount, tap a category and payment mode, Save. Change the date at the top to log something from an earlier day. **+ New** adds a category on the spot.
- **Month** — spent vs budget, safe-to-spend per day, each category's bar (orange = over budget), all entries. Tap an entry to edit or delete it.
- **Summary** — the month in plain words, compared with the month before. Use ‹ › to see past months.
- **Settings** — rename categories, set monthly budgets (0 = no limit), download a CSV backup, or lock the device.
- **No signal?** Saves are kept on the phone and sent automatically once you're back online ("waiting to sync").

## Changing the PIN

Update the `EXPENSE_PIN` secret, then re-run the deploy workflow. Each device will ask for the new PIN.
