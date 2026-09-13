// بات دستیار پست‌گذاریِ NivaroMusic — پروژه‌ی کاملا جدا (Worker مستقل)
//
// این پروژه هیچ ربطی به ریپو/بات اصلی نداره: توکن جدا، ریپوی گیت‌هاب جدا،
// دیپلوی جدا. تنها چیزی که با بات اصلی مشترکه، همون دیتابیس D1 هست.
//
// کارش: توی چت خصوصی (فقط برای OWNER_ID خودت) یه فایل صوتی می‌گیره، کپشن رو
// طبق CAPTION_TEMPLATE پایین همین فایل می‌سازه، بعد به‌عنوان پیش‌نمایشِ
// نهایی (دقیقا همون‌طوری که قراره توی کانال دیده بشه) برات می‌فرسته و
// می‌پرسه «این رو توی کانال پست کنم یا نه». فقط با تاییدِ خودت (دکمه‌ی
// «📤 ارسال به کانال») واقعاً توی CHANNEL_ID پست می‌شه؛ اگه بزنی «❌ انصراف»
// هیچ‌جا پست نمی‌شه.
//
// دکمه‌ی شیشه‌ای زیر آهنگ: با کلیک روش، کاربر می‌ره توی بات اصلی
// (MAIN_BOT_USERNAME) و همونجا خودکار اسم آهنگ براش سرچ می‌شه (دقیقا مثل
// اینکه خودش اسم آهنگ رو تایپ کرده باشه) و بات اصلی لیست نتایج رو مثل
// حالت عادی نشون می‌ده.

// 👇👇 کپشن دلخواهت (فرمت خودت) — {title} و {performer} خودکار جایگزین می‌شن.
const CAPTION_TEMPLATE = `NivaroMusic

◈ ━━━━━━━━━━━━ ◈
◈ Track : {title}
◈ Artist : {performer}
◈ ━━━━━━━━━━━━ ◈

❝ Just close your eyes & feel it ❞

 @NivaroMusic`;

const SEARCH_BUTTON_TEXT = "🎧 جستجوی این آهنگ";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("ok"); // مسیر/متد دیگه‌ای نیست، چیزی برای انجام دادن نداریم
    }

    if (env.POSTER_WEBHOOK_SECRET) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.POSTER_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
      }
    } catch (e) {
      console.error("poster webhook error:", e);
    }

    return new Response("ok");
  },
};

// ── پیام‌های خصوصی به بات دستیار ──────────────────────────────

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isOwner(env, userId)) {
    await sendMessage(env, chatId, "⛔️ این بات فقط برای خودِ صاحبش قابل استفاده‌ست.");
    return;
  }

  if (msg.text?.startsWith("/start")) {
    await sendMessage(
      env,
      chatId,
      "سلام 👋\nهر فایل صوتی که برام بفرستی رو با کپشن آماده می‌سازم، برات پیش‌نمایش می‌فرستم و فقط با تاییدِ خودت می‌ذارم توی کانال."
    );
    return;
  }

  // اگه منتظر ویرایش دستیِ عنوان/خواننده هستیم، این پیام متنی همونه
  if (msg.text) {
    const pending = await getPending(env, userId);
    if (pending && pending.awaiting_field) {
      const value = msg.text.trim();
      await updatePendingField(env, userId, pending.awaiting_field, value);
      await clearAwaitingField(env, userId);
      await sendPreview(env, chatId, userId);
      return;
    }
  }

  if (msg.audio) {
    await handleIncomingAudio(msg, env);
    return;
  }

  if (msg.text) {
    await sendMessage(env, chatId, "یه فایل صوتی (audio) برام بفرست تا شروع کنیم 🎵");
  }
}

// فایل جدید رسید ⇒ توی pending_posts ذخیره‌ش کن و پیش‌نمایش کپشن رو نشون بده
async function handleIncomingAudio(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const audio = msg.audio;

  const pending = await getPending(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(
      env,
      chatId,
      "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه (ارسال به کانال یا انصراف). اول اون رو جواب بده، بعد فایل جدید بفرست."
    );
    return;
  }

  const title = audio.title || stripExtension(audio.file_name) || "بدون عنوان";
  const performer = audio.performer || "نامشخص";

  await env.DB.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'awaiting_confirm')
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       performer = excluded.performer,
       duration = excluded.duration,
       awaiting_field = NULL,
       status = 'awaiting_confirm'`
  )
    .bind(userId, audio.file_id, audio.file_name || null, title, performer, audio.duration || null)
    .run();

  await sendPreview(env, chatId, userId);
}

// پیش‌نمایش کپشنِ ساخته‌شده + دکمه‌های تایید/ویرایش/انصراف
async function sendPreview(env, chatId, userId) {
  const pending = await getPending(env, userId);
  if (!pending) return;

  const caption = buildCaption(pending.title, pending.performer);
  const text = `پیش‌نمایش کپشن:\n\n${caption}\n\nهمه‌چی درسته؟`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "✅ تایید و ساخت پست نهایی", callback_data: `pconfirm:${userId}` }],
      [
        { text: "✏️ ویرایش عنوان", callback_data: `pedit_t:${userId}` },
        { text: "✏️ ویرایش خواننده", callback_data: `pedit_p:${userId}` },
      ],
      [{ text: "❌ انصراف", callback_data: `pcancel:${userId}` }],
    ],
  };

  await sendMessage(env, chatId, text, reply_markup);
}

// ── دکمه‌ها ──────────────────────────────────────────────────

async function handleCallbackQuery(cq, env) {
  const chatId = cq.message?.chat?.id;
  const userId = cq.from?.id;
  const data = cq.data || "";
  const parts = data.split(":");
  const action = parts[0];
  const ownerId = Number(parts[1]);

  if (!chatId || !isOwner(env, userId)) {
    await answerCallbackQuery(env, cq.id, "⛔️ اجازه نداری.");
    return;
  }

  // امنیت: فقط خودِ کسی که این پست رو شروع کرده می‌تونه دکمه‌هاشو بزنه
  if (ownerId !== userId) {
    await answerCallbackQuery(env, cq.id, "این پیام مال تو نیست.");
    return;
  }

  const pending = await getPending(env, userId);
  if (!pending) {
    await answerCallbackQuery(env, cq.id, "چیزی برای ادامه پیدا نشد. یه فایل جدید بفرست.");
    return;
  }

  if (action === "pcancel") {
    await deletePending(env, userId);
    await answerCallbackQuery(env, cq.id, "لغو شد.");
    await sendMessage(env, chatId, "❌ لغو شد. هیچ‌جا پست نشد.");
    return;
  }

  if (action === "pedit_t" || action === "pedit_p") {
    const field = action === "pedit_t" ? "title" : "performer";
    await setAwaitingField(env, userId, field);
    await answerCallbackQuery(env, cq.id);
    await sendMessage(
      env,
      chatId,
      field === "title" ? "اسم جدید آهنگ رو بفرست:" : "اسم جدید خواننده رو بفرست:"
    );
    return;
  }

  if (action === "pconfirm") {
    await answerCallbackQuery(env, cq.id);
    await sendFinalPreview(env, chatId, userId, pending);
    return;
  }

  if (action === "ppublish") {
    const linkId = Number(parts[2]);
    await answerCallbackQuery(env, cq.id);
    await publishToChannel(env, chatId, pending, linkId);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// پیش‌نمایش نهایی: دقیقا همون چیزی که قراره توی کانال دیده بشه (فایل صوتی +
// کپشن کامل + دکمه‌ی شیشه‌ای جستجو)، ولی فقط برای خودِ کاربر (توی همین
// چت خصوصی) با دو تا دکمه‌ی «ارسال به کانال» / «انصراف» زیرش
async function sendFinalPreview(env, chatId, userId, pending) {
  const botUsername = env.MAIN_BOT_USERNAME;
  if (!botUsername) {
    await sendMessage(
      env,
      chatId,
      "⚠️ متغیر MAIN_BOT_USERNAME تنظیم نشده؛ توی wrangler.toml (بخش [vars]) اضافه‌ش کن."
    );
    return;
  }

  // یه ردیف توی search_links می‌سازیم که فقط شماره‌ش (نه خودِ متن فارسی)
  // توی لینکِ دکمه بره — چون لینک‌های تلگرام فقط حروف/عدد انگلیسی قبول می‌کنن
  const linkId = await createSearchLink(env, pending.title);

  const caption = buildCaption(pending.title, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  const body = {
    chat_id: chatId, // فقط پیش‌نمایش، برای خودِ کاربر
    audio: pending.file_id,
    caption,
    title: pending.title,
    performer: pending.performer,
    reply_markup: {
      inline_keyboard: [
        [{ text: SEARCH_BUTTON_TEXT, url: deepLink }],
        [
          { text: "📤 ارسال به کانال", callback_data: `ppublish:${userId}:${linkId}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}` },
        ],
      ],
    },
  };
  if (pending.duration) body.duration = pending.duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!data.ok) {
    await sendMessage(
      env,
      chatId,
      `❌ ساخت پیش‌نمایش با خطا مواجه شد:\n${data.description || "خطای نامشخص"}`
    );
    return;
  }

  await setStatus(env, userId, "awaiting_publish");
  await sendMessage(env, chatId, "این بالا دقیقا همون چیزیه که می‌خواد توی کانال پست بشه. ارسالش کنم؟");
}

// وقتی روی «📤 ارسال به کانال» زدی: واقعاً می‌فرسته توی CHANNEL_ID
// و توی جدول songs هم ثبتش می‌کنه (تا بات اصلی هم بشناستش)
async function publishToChannel(env, chatId, pending, linkId) {
  const channelId = env.CHANNEL_ID;
  const botUsername = env.MAIN_BOT_USERNAME;

  if (!channelId) {
    await sendMessage(
      env,
      chatId,
      "⚠️ متغیر CHANNEL_ID تنظیم نشده؛ توی wrangler.toml (بخش [vars]) آیدی عددی کانال رو اضافه کن (بات باید ادمین کانال هم باشه)."
    );
    return;
  }

  const caption = buildCaption(pending.title, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  const body = {
    chat_id: channelId,
    audio: pending.file_id,
    caption,
    title: pending.title,
    performer: pending.performer,
    reply_markup: {
      inline_keyboard: [[{ text: SEARCH_BUTTON_TEXT, url: deepLink }]],
    },
  };
  if (pending.duration) body.duration = pending.duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!data.ok) {
    await sendMessage(
      env,
      chatId,
      `❌ پست توی کانال با خطا مواجه شد:\n${data.description || "خطای نامشخص"}\n\n(مطمئن شو بات دوم رو توی کانال ادمین کردی)`
    );
    return;
  }

  const sentMessageId = data.result.message_id;

  await env.DB.prepare(
    `INSERT INTO songs (chat_id, message_id, title, performer, file_name, caption, duration)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(message_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       title = excluded.title,
       performer = excluded.performer,
       file_name = excluded.file_name,
       caption = excluded.caption,
       duration = excluded.duration`
  )
    .bind(channelId, sentMessageId, pending.title, pending.performer, pending.file_name, caption, pending.duration)
    .run();

  await deletePending(env, pending.admin_id);

  await sendMessage(env, chatId, "✅ توی کانال پست شد.");
}

async function createSearchLink(env, query) {
  const res = await env.DB.prepare(`INSERT INTO search_links (query) VALUES (?1)`)
    .bind(query || "")
    .run();
  return res.meta.last_row_id;
}

// ── دسترسی به pending_posts ────────────────────────────────────

async function getPending(env, userId) {
  return await env.DB.prepare(`SELECT * FROM pending_posts WHERE admin_id = ?1`)
    .bind(userId)
    .first();
}

async function updatePendingField(env, userId, field, value) {
  const col = field === "title" ? "title" : "performer";
  await env.DB.prepare(`UPDATE pending_posts SET ${col} = ?1 WHERE admin_id = ?2`)
    .bind(value, userId)
    .run();
}

async function setAwaitingField(env, userId, field) {
  await env.DB.prepare(`UPDATE pending_posts SET awaiting_field = ?1 WHERE admin_id = ?2`)
    .bind(field, userId)
    .run();
}

async function clearAwaitingField(env, userId) {
  await env.DB.prepare(`UPDATE pending_posts SET awaiting_field = NULL WHERE admin_id = ?1`)
    .bind(userId)
    .run();
}

async function setStatus(env, userId, status) {
  await env.DB.prepare(`UPDATE pending_posts SET status = ?1 WHERE admin_id = ?2`)
    .bind(status, userId)
    .run();
}

async function deletePending(env, userId) {
  await env.DB.prepare(`DELETE FROM pending_posts WHERE admin_id = ?1`).bind(userId).run();
}

// ── کمکی ────────────────────────────────────────────────────────

function isOwner(env, userId) {
  if (!userId) return false;
  const ids = String(env.OWNER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(userId));
}

function buildCaption(title, performer) {
  return CAPTION_TEMPLATE.split("{title}")
    .join(title || "")
    .split("{performer}")
    .join(performer || "");
}

function stripExtension(fileName) {
  if (!fileName) return null;
  return fileName.replace(/\.[^/.]+$/, "");
}

// ── توابع پایه‌ی تلگرام ──────────────────────────────────────

async function sendMessage(env, chatId, text, reply_markup) {
  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
  });
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}
