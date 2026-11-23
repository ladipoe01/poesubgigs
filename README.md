# SubsGigs cloud worker

One Railway process that does what userscript v19.2.2 did in the browser: watch live campaign capacity, wait out priority windows, and POST the Next.js save as soon as a spot can be taken.

The browser HUD, chime, and Tampermonkey menu are gone. Alerts go to Telegram. Campaign submissions run in a headless Playwright browser with a persistent profile under `/data/profile`; the Supabase session state is stored at `/data/session.json`.

## What you need

- A Railway account
- One GitHub repo containing this folder
- A logged-in SubsGigs session (recommended), or the site username and password
- A Railway volume mounted at `/data`
- A Telegram bot token and chat id, if you want alerts

Run **one replica**. Two copies will both try to save the same spot.

Set Railway region near London. The site is served from Vercel `lhr1`.

Turn **App Sleep / Serverless off**. Leave the cron schedule empty.

## 1. Session

Log in on the site in your own browser. Open the console and paste:

```js
(() => {
  const parts = document.cookie.split('; ').map(p => {
    const i = p.indexOf('=');
    const name = p.slice(0, i);
    let value = p.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    return [name, value];
  });
  const names = parts.filter(([name]) => /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/.test(name));
  if (!names.length) return alert('No auth cookie. Log in first.');
  const base = names[0][0].replace(/\.\d+$/, '');
  const raw = names
    .filter(([name]) => name === base || name.startsWith(base + '.'))
    .sort((a, b) => {
      const ai = a[0] === base ? -1 : Number(a[0].slice(base.length + 1));
      const bi = b[0] === base ? -1 : Number(b[0].slice(base.length + 1));
      return ai - bi;
    })
    .map(([, value]) => value)
    .join('');
  let json = raw;
  if (json.startsWith('base64-')) {
    const b64 = json.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    json = new TextDecoder().decode(Uint8Array.from(atob(pad), c => c.charCodeAt(0)));
  }
  copy(json);
  console.log('Copied. Paste it into Railway as SG_SESSION_JSON.');
})();
```

That value is a secret. Put it only in Railway variables.

The site rotates the refresh token. Mount a Railway volume at `/data` so the refreshed token and Playwright browser profile survive restarts. `STATE_PATH` defaults to `/data/session.json` and `BROWSER_PROFILE_PATH` defaults to `/data/profile` on Railway.

`campaign_capacity` is readable with the publishable key. The live campaign list, profile, and your holds are not. Those need the session token. Until a session is loaded, the log stays on `SIGNED OUT` and `live=0`.

If you later paste a fresh session, set `SG_SESSION_FORCE=true` for one deploy so the old file does not win. Then set it back to `false`.

`SG_USERNAME` and `SG_PASSWORD` are the fallback when there is no session. Railway datacenter IPs may receive Vercel's checkpoint page instead of the login form. The persistent browser keeps cookies and browser state between restarts, but it does not bypass a security checkpoint. When a checkpoint is detected, the worker pauses rather than trying to evade verification. Use an approved access method or contact the site operator if the worker is consistently blocked.

## 2. Deploy

1. Push this folder to GitHub.
2. Railway: New Project, Deploy from GitHub, select the repo.
3. Add a volume. Mount path: `/data`.
4. Settings: replicas `1`, App Sleep off, region close to London. Keep the volume mounted at `/data` on every deploy.
5. Variables, from `.env.example`:
   - `SG_SESSION_JSON`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `DRY_RUN=true` for the first boot
6. Deploy. Open the logs. You want `health on :8080/health`, then `baseline ready`, then a `status` line each minute.
7. When the status looks right, set `DRY_RUN=false` and redeploy.

`/health` is public and only returns `{"ok":true}`. Set `STATUS_TOKEN` if you want `GET /status` with `Authorization: Bearer <token>`.

Do not commit `data/session.json`, `.env`, or browser profile files. The repository previously contained a session file; removing it from this branch does not erase it from Git history. Revoke the exposed session by signing out of SubsGigs or rotating the refresh token, then create a fresh session and store it only in Railway variables. Also revoke any Telegram bot token that was ever exposed and replace it.

## Behavior carried over

- Capacity poll defaults to 150ms. A Railway floor of 50ms blocks a zero value. 150ms is about 576,000 Supabase reads a day before the other sync calls. Raise `FAST_POLL_MS` if the project hits a quota.
- Spots already open at process start are ignored when `BASELINE=true`. The worker saves the next spot that appears, or a spot that closes and opens again.
- Own holds are renewed from `campaign_spot_reservations`. When one expires, it tries that campaign again.
- Priority windows wait until one network delay before the public open, using the same lead math as v19.2.2.
- At most `MAX_POSTS_PER_HOUR` saves per campaign (default 8).
- HTTP 429, 502, 503, and a Vercel checkpoint pause saves. The pause starts at 60s and doubles up to 5 minutes. Capacity polling continues.

## Local check

```powershell
cd C:\Users\HP\subsgigs-cloud
$env:DRY_RUN='true'
$env:TELEGRAM_ENABLED='false'
$env:FAST_POLL_MS='5000'
node src/index.js
```

Stop it with Ctrl+C. Do not put `SG_SESSION_JSON` in a file you might commit.
