export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim();

          // دستور /start
          if (text === "/start") {
            await sendMessage(env.BOT_TOKEN, chatId, "سلام! 🚀\nلینک ویدیو (اینستاگرام، یوتیوب، تیک‌تاک یا...) رو برام بفرست تا فایلش رو برات دانلود کنم!");
            return new Response("OK");
          }

          // بررسی لینک بودن متن
          if (text.startsWith("http://") || text.startsWith("https://")) {
            await sendMessage(env.BOT_TOKEN, chatId, "⏳ در حال پردازش و دریافت لینک دانلود...");

            // استفاده از API رایگان دانلود (Cobalt API)
            const apiUrl = "https://api.cobalt.tools/api/json";
            const response = await fetch(apiUrl, {
              method: "POST",
              headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ url: text })
            });

            const data = await response.json();

            if (data.status === "redirect" || data.status === "stream") {
              const downloadUrl = data.url;
              // ارسال ویدیو به کاربر
              await sendVideo(env.BOT_TOKEN, chatId, downloadUrl);
            } else if (data.status === "picker") {
              // در صورتی که چند کیفیت/عکس باشه
              await sendMessage(env.BOT_TOKEN, chatId, `🎬 لینک مستقیم دانلود:\n${data.picker[0].url}`);
            } else {
              await sendMessage(env.BOT_TOKEN, chatId, "❌ متأسفانه نتونستم این لینک رو دانلود کنم. مطمئن شو لینک عمومی هست.");
            }
          } else {
            await sendMessage(env.BOT_TOKEN, chatId, "لطفاً یک لینک معتبر ارسال کن.");
          }
        }
      } catch (err) {
        console.error(err);
      }
      return new Response("OK");
    }

    return new Response("Bot is running!");
  }
};

// تابع ارسال پیام متنی
async function sendMessage(token, chatId, text) {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

// تابع ارسال ویدیو
async function sendVideo(token, chatId, videoUrl) {
  return fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption: "⚡️ دانلود شده توسط ربات رایگان کلودفلر" })
  });
}
