// Cloudflare Worker - Telegram video downloader bot
// Env vars needed: BOT_TOKEN (secret), COBALT_API (url), WEBHOOK_SECRET (secret)
// Optional: COBALT_KEY (secret) if your Cobalt instance requires an API key

const URL_REGEX = /https?:\/\/[^\s]+/i;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot is running");

    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Reply to Telegram immediately, process in background
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith("/start")) {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "سلام! 👋\nلینک ویدیو (اینستاگرام، تیک‌تاک، توییتر، یوتیوب و ...) را بفرست تا برایت دانلود کنم.",
    });
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "لطفاً یک لینک معتبر بفرست.",
    });
  }

  const link = match[0];
  const wait = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "⏳ در حال پردازش...",
    reply_to_message_id: msg.message_id,
  });
  const waitId = wait?.result?.message_id;

  try {
    const result = await resolveLink(env, link);

    if (result.error) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `❌ خطا: ${result.error}`,
      });
    } else {
      for (const item of result.items) {
        await sendMedia(env, chatId, item);
      }
    }
  } catch (e) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ مشکلی در دانلود پیش آمد. دوباره تلاش کن.",
    });
  }

  if (waitId) {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: waitId });
  }
}

// ---------- Free built-in extractors (no server needed) ----------

async function resolveLink(env, link) {
  const host = (() => {
    try {
      return new URL(link).hostname.replace(/^www\.|^m\.|^vm\.|^vt\./, "");
    } catch {
      return "";
    }
  })();

  try {
    if (host.includes("tiktok.com")) return await resolveTikTok(link);
    if (host === "twitter.com" || host === "x.com") return await resolveTwitter(link);
    if (host.includes("instagram.com")) return await resolveInstagram(link);
  } catch (e) {
    // fall through to optional Cobalt fallback
  }

  // Optional fallback for Instagram/YouTube/etc. (only if you set COBALT_API)
  if (env.COBALT_API && !env.COBALT_API.includes("YOUR-COBALT")) {
    return await resolveWithCobalt(env, link);
  }

  return {
    error:
      "این سایت فعلاً پشتیبانی نمی‌شود. (پشتیبانی فعلی: TikTok، Twitter/X و Instagram)",
  };
}

async function resolveTikTok(link) {
  const res = await fetch(
    `https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(link)}`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  const json = await res.json();
  if (json.code !== 0 || !json.data) return { error: "ویدیو پیدا نشد" };

  const d = json.data;
  if (Array.isArray(d.images) && d.images.length) {
    return {
      items: d.images.slice(0, 10).map((u) => ({ type: "photo", url: u })),
    };
  }
  const videoUrl = d.hdplay || d.play;
  if (!videoUrl) return { error: "لینک ویدیو پیدا نشد" };
  return { items: [{ type: "video", url: videoUrl }] };
}

async function resolveTwitter(link) {
  const m = link.match(/(?:twitter|x)\.com\/([^\/?#]+)\/status\/(\d+)/i);
  if (!m) return { error: "لینک توییت نامعتبر است" };

  const res = await fetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const json = await res.json();
  const media = json?.tweet?.media;
  if (!media) return { error: "این توییت مدیایی ندارد" };

  const items = [];
  for (const v of media.videos || []) items.push({ type: "video", url: v.url });
  if (!items.length) {
    for (const p of media.photos || []) items.push({ type: "photo", url: p.url });
  }
  if (!items.length) return { error: "این توییت مدیایی ندارد" };
  return { items: items.slice(0, 10) };
}

// ---------- Instagram via save-free.app (visolix API) ----------

const IG_BASE = "https://save-free.app";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function findNonce(html) {
  const patterns = [
    /visolix[^<]{0,600}?nonce["']?\s*[:=]\s*["']([a-zA-Z0-9]{8,14})["']/i,
    /["']?nonce["']?\s*[:=]\s*["']([a-f0-9]{10})["']/i,
    /x-visolix-nonce["']?\s*[:=,]\s*["']([a-zA-Z0-9]{8,14})["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

// Walk the JSON response and collect anything that looks like a media URL
function collectUrls(node, out = new Set()) {
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node)) out.add(node);
  } else if (Array.isArray(node)) {
    node.forEach((n) => collectUrls(n, out));
  } else if (node && typeof node === "object") {
    Object.values(node).forEach((n) => collectUrls(n, out));
  }
  return out;
}

async function resolveInstagram(link) {
  try {
    // 1) get a fresh nonce from the home page
    const home = await fetch(`${IG_BASE}/`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const html = await home.text();
    const nonce = findNonce(html);
    if (!nonce) return { error: "توکن سایت پیدا نشد (ساختار سایت عوض شده؟)" };

    // 2) call the download API
    const res = await fetch(`${IG_BASE}/wp-json/visolix/api/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Origin: IG_BASE,
        Referer: `${IG_BASE}/`,
        "User-Agent": BROWSER_UA,
        "x-visolix-nonce": nonce,
      },
      body: JSON.stringify({ url: link, format: "", captcha_response: null }),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `پاسخ نامعتبر از سایت (کد ${res.status})` };
    }

    // 3) the API returns {status, data: "<html ...>"}; extract download anchors
    if (!json.status || typeof json.data !== "string") {
      const msg = json.message || json.error;
      return { error: msg ? String(msg) : "سایت پاسخ معتبری نداد" };
    }

    const items = [];
    const anchorRe = /<a\b[^>]*href="([^"]*dl\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(json.data)) !== null) {
      const href = m[1].replace(/&amp;/g, "&");
      const label = m[2].replace(/<[^>]*>/g, " ");
      let abs;
      try {
        abs = new URL(href, IG_BASE + "/").toString(); // resolves the "/../" in the path
      } catch {
        continue;
      }
      items.push({
        type: /video|mp4/i.test(label) ? "video" : "photo",
        url: abs,
        proxy: true, // Worker downloads it and uploads to Telegram
      });
    }

    if (!items.length) {
      return { error: "لینکی پیدا نشد (ممکن است پست خصوصی باشد)" };
    }
    return { items: items.slice(0, 10) };
  } catch (e) {
    return { error: "خطا در اتصال به سایت اینستاگرام" };
  }
}

// ---------- Optional Cobalt fallback ----------

async function resolveWithCobalt(env, link) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (env.COBALT_KEY) headers.Authorization = `Api-Key ${env.COBALT_KEY}`;

  const res = await fetch(env.COBALT_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: link, videoQuality: "720" }),
  });
  const data = await res.json();

  switch (data.status) {
    case "tunnel":
    case "redirect":
      return { items: [{ type: "video", url: data.url }] };
    case "picker":
      return {
        items: (data.picker || []).slice(0, 10).map((p) => ({
          type: p.type === "photo" ? "photo" : "video",
          url: p.url,
        })),
      };
    case "error":
      return { error: data.error?.code || "unknown" };
    default:
      return { error: "پاسخ نامعتبر از سرور" };
  }
}

async function sendMedia(env, chatId, item) {
  const method = item.type === "photo" ? "sendPhoto" : "sendVideo";
  const field = item.type === "photo" ? "photo" : "video";

  const r = item.proxy
    ? await uploadToTelegram(env, chatId, item, method, field)
    : await tg(env, method, {
        chat_id: chatId,
        [field]: item.url,
        supports_streaming: true,
      });

  // Telegram can't fetch files bigger than ~20MB by URL -> send direct link instead
  if (!r || !r.ok) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `📥 فایل برای ارسال مستقیم بزرگ است. از این لینک دانلود کن:\n${item.url}`,
    });
  }
}

// Download a file inside the Worker and upload it to Telegram (limit: 50MB)
async function uploadToTelegram(env, chatId, item, method, field) {
  const MAX = 50 * 1024 * 1024;
  try {
    const f = await fetch(item.url, {
      headers: { "User-Agent": BROWSER_UA, Referer: `${IG_BASE}/` },
    });
    if (!f.ok) return null;

    const type = f.headers.get("content-type") || "";
    if (type.includes("text/html")) return null; // got an error page, not media

    const len = Number(f.headers.get("content-length") || 0);
    if (len > MAX) return null;

    const blob = await f.blob();
    if (blob.size > MAX) return null;

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(field, blob, item.type === "photo" ? "photo.jpg" : "video.mp4");
    if (item.type !== "photo") form.append("supports_streaming", "true");

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      body: form,
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => null);
}
