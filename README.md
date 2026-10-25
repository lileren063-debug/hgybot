# HGY bot – HEGEMONY Telegram Mini App

Pixel World clan tracker (@HGYinfo_bot) for clan HEGEMONY (team 5).

- `index.html` – the Telegram Mini App (single file)
- `worker/hegemony-members-worker.js` – handler for `/api/clans/5/members?range=month|week`
- `functions/api/[[path]].js` – Pages Function serving `/api` on the same site

## Yayınlama (Cloudflare Pages)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → `hgybot` reposunu seç.
2. Build ayarları: Framework yok, build command boş, output directory `/`. Deploy.
3. Çıkan adresi (ör. `https://hgybot.pages.dev`) BotFather'da ayarla: `/mybots` → bot → Bot Settings → **Configure Mini App** (veya Menu Button) → URL.
4. Bundan sonra GitHub'a her push otomatik yayınlanır.

## API (/api)

`functions/api/[[path]].js` bir Pages Function'dır ve Pages ile birlikte otomatik yayınlanır:

- `/api/clans/:teamId/members?range=day|week|month` → herhangi bir klanın günlük/haftalık/aylık puanları.
  Giriş gerektirmeyen mrktsticker `global/clan-players` sıralamasından süzülür (`worker/clan-points.js`).
  HEGEMONY (5) için `PW_AUTHORIZATION` / `PW_COOKIE` secret'ı tanımlıysa doğrudan pw.game kullanılır.
- `/api/platform`, `/api/giveaways`, `/api/rewards`, `/api/tasks` → kendi D1 veritabanımız (aşağıya bak).
- diğer tüm `/api/...` istekleri → `https://mrktsticker.alwaysdata.net/api`

İsteğe bağlı: doğrudan pw.game kullanmak için Pages projesine secret ekle: Pages projesi → **Settings** → **Variables and Secrets** → **Add** →
tür **Secret**, ad `PW_COOKIE`, değer pw.game Cookie'si → Save. Sonra **Deployments** → son deploy → **Retry deployment**.

## Çok klanlı platform (ortak depo)

Klanlar, yöneticiler, çekilişler, ödüller, görevler ve oyuncu bağlantıları kendi Cloudflare D1
veritabanımızda ayrı tablolarda tutulur (`worker/hgy-store.js`). Her yazma isteği Telegram initData
ile doğrulanır ve yetkiler sunucuda kontrol edilir.

Roller:
- **Ana yönetici**: `SUPER_ADMIN_IDS` (varsayılan Eren, 1563597048). Klan ekler/kaldırır, her klan için
  çekiliş ve görev iznini açar/kapatır, yönetici atar/kaldırır, yanlış oyuncu bağlantısını sıfırlar.
- **Klan yöneticisi**: yalnızca kendi klanında açık olan her şeyi yönetir.
- **Görevli yönetici**: yalnızca kendisine verilen yetkiyi (çekiliş/ödül veya görev) kendi klanında kullanır.
- **Kullanıcı**: çekilişlere katılır, ödül alır, görev yapar.

HGY puanı (UTC ay başında sıfırlanır) = bağlı oyuncunun aylık klan puanı + görev ödülleri − çekiliş girişleri − ödüller.

Görev türleri: klan savaşı puan hedefi (oyuncunun kendi puanı veya klan toplamı; günlük/haftalık/sezon,
otomatik kontrol), Telegram kanal/grup katılımı (bot o kanalda admin olmalı, otomatik kontrol),
oyun içi etkinlik (yönetici onaylar).

Kurulum (bir kez):
1. Cloudflare → **Storage & Databases → D1** → **Create database** → ad: `hgy-db`.
2. hgybot Pages projesi → **Settings → Bindings → Add → D1 database** → Variable name `DB`, database `hgy-db` → Save.
3. Aynı sayfada **Variables and Secrets → Add** → Type **Secret**, Name `BOT_TOKEN`, Value: BotFather'daki bot token'ı → Save.
   (İsteğe bağlı: başka ana yönetici için `SUPER_ADMIN_IDS` = virgülle ayrılmış Telegram id'leri.)
4. **Deployments** → son deploy → **Retry deployment**. Tablolar ilk istekte kendiliğinden oluşur.
5. Kanal görevleri için botu @HegemonyGames kanalına **admin**, @hegemonyprivate grubuna üye/admin olarak ekle.

Gizli bilgiler **asla** bu repoya yazılmaz (repo herkese açık). pw.game oturumunu Worker secret olarak sakla:

```
npx wrangler pages secret put PW_COOKIE --project-name hgybot
```

HAR dosyalarını da repoya koyma.

## Bot profile, commands and welcome message

`worker/telegram-bot.js` handles the chat side of the bot. The main admin opens
Profile → Main Admin Panel → **Apply Bot Setup** once; that sets the bot name,
description, short description, command list (English + Turkish), the menu button
and the webhook `/api/telegram/webhook`. After that `/start` sends the welcome
message with an Open App button, and `/giveaways`, `/tasks`, `/rewards`, `/profile`
and `/help` answer with buttons that open the app on that page. The webhook secret
is derived from `BOT_TOKEN`, so no extra secret is needed. Edit the texts in
`TEXT` and press the button again to change them.

## Activity messages to the main admin

The bot sends the main admin (or the ids in the optional `NOTIFY_IDS` variable) a
Telegram message when someone opens the app for the first time, links a Pixel World
player, completes or requests a task, joins a giveaway or claims a reward. The main
admin's own actions are not reported. The receiver must have started the bot once.

## Daily announcement

Main Admin Panel → **Daily announcement**: message, optional image, **send privately to
all bot users** (everyone who opened the app or wrote to the bot; users who blocked the bot
are skipped), optional channels/groups, hour and an on/off switch, plus **Send now**.
Private messages go out in batches of 22 (Workers request limit); the admin panel and the
hourly workflow keep calling `/api/cron/daily` until all are sent. An uploaded image is
stored in D1 and served from `/api/announce-image`. The server posts it at most once a day
(state in D1 `meta.announce_v1`). It is triggered by app visits and by the hourly
GitHub Actions workflow `.github/workflows/daily-announcement.yml`, which calls
`/api/cron/daily`. The bot must be an admin of each channel (or a member of the group).
