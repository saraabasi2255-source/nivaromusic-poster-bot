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
const CAPTION_TEMPLATE = `🎧NivaroMusic

◈ ━━━━━━━━━━━━ ◈
◈ Track : {title}
◈ Artist : {performer}
◈ ━━━━━━━━━━━━ ◈

❝ Just close your eyes & feel it ❞

 🆔@NivaroMusic`;

const SEARCH_BUTTON_TEXT = "All Version";

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
      // 🔍 تشخیصیِ موقت: ببینیم اصلا چه نوع آپدیتی می‌رسه (بعد از رفع مشکل حذفش می‌کنیم)
      if (env.DEBUG_UPDATES === "1") {
        for (const ownerId of getOwnerIds(env)) {
          await sendMessage(env, ownerId, `🔍 آپدیت رسید: ${Object.keys(update).join(", ")}`);
        }
      }

      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
      } else if (update.channel_post) {
        await handleChannelPost(update.channel_post, env);
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
      "سلام 👋\n🎵 فایل صوتی بفرستی: کپشن آماده می‌سازم و بعد از تاییدت می‌ذارم توی کانال.\n🎙 ویس بفرستی: ازت لینک دانلود می‌خوام و زیرش دکمه‌اش می‌کنم.\nهیچ‌کدوم بدون تاییدِ خودت پست نمی‌شه."
    );
    return;
  }

  // اگه منتظر ویرایش دستیِ عنوان/خواننده یا گرفتنِ لینکِ دانلود هستیم،
  // این پیام متنی همونه
  if (msg.text) {
    const pending = await getPending(env, userId);
    if (pending && pending.awaiting_field) {
      const value = msg.text.trim();

      if (pending.awaiting_field === "link") {
        await setLink(env, userId, value);
        await clearAwaitingField(env, userId);
        await sendVoiceFinalPreview(env, chatId, userId);
        return;
      }

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

  if (msg.voice) {
    await handleIncomingVoice(msg, env);
    return;
  }

  if (msg.text) {
    await sendMessage(env, chatId, "یه فایل صوتی (audio) یا ویس بفرست تا شروع کنیم 🎵");
  }
}

// ویس جدید رسید ⇒ توی pending_posts ذخیره‌ش کن و لینک دانلود رو ازش بپرس
async function handleIncomingVoice(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const voice = msg.voice;

  const pending = await getPending(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(
      env,
      chatId,
      "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه (ارسال به کانال یا انصراف). اول اون رو جواب بده، بعد فایل جدید بفرست."
    );
    return;
  }

  await env.DB.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link)
     VALUES (?1, ?2, NULL, NULL, NULL, ?3, 'link', 'awaiting_confirm', 'voice', NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = NULL,
       title = NULL,
       performer = NULL,
       duration = excluded.duration,
       awaiting_field = 'link',
       status = 'awaiting_confirm',
       kind = 'voice',
       link = NULL`
  )
    .bind(userId, voice.file_id, voice.duration || null)
    .run();

  await sendMessage(env, chatId, "🔗 لینک دانلود رو بفرست تا زیرِ ویس دکمه‌اش کنم:");
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
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'awaiting_confirm', 'audio', NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       performer = excluded.performer,
       duration = excluded.duration,
       awaiting_field = NULL,
       status = 'awaiting_confirm',
       kind = 'audio',
       link = NULL`
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

  if (action === "vpublish") {
    await answerCallbackQuery(env, cq.id);
    await publishVoiceToChannel(env, chatId, pending);
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

  // به‌جای خودِ عنوان کامل (که ممکنه «Sped Up»، «Slowed» و... داشته باشه و
  // باعث بشه نسخه‌های دیگه‌ی همین آهنگ که این کلمات رو ندارن پیدا نشن)،
  // اول اسمِ «اصلی» آهنگ رو در میاریم و همراه با اسم خواننده ذخیره می‌کنیم.
  // این‌طوری هر نسخه‌ای از همین آهنگ (چه اسمش توصیف داشته باشه چه نداشته
  // باشه) پیدا می‌شه، ولی چون اسم خواننده هم شرطه، به آهنگ‌های دیگه سرایت
  // نمی‌کنه.
  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();

  // یه ردیف توی search_links می‌سازیم که فقط شماره‌ش (نه خودِ متن فارسی)
  // توی لینکِ دکمه بره — چون لینک‌های تلگرام فقط حروف/عدد انگلیسی قبول می‌کنن
  const linkId = await createSearchLink(env, searchQuery, pending.performer);

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

// پیش‌نمایش نهاییِ ویس: خودِ ویس + دکمه‌ی شیشه‌ای «دانلود آهنگ» (با لینکی
// که خودت دادی)، فقط برای خودِ کاربر، با دو دکمه‌ی ارسال به کانال/انصراف
async function sendVoiceFinalPreview(env, chatId, userId) {
  const pending = await getPending(env, userId);
  if (!pending) return;

  const body = {
    chat_id: chatId,
    voice: pending.file_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "⬇️ دانلود آهنگ", url: pending.link }],
        [
          { text: "📤 ارسال به کانال", callback_data: `vpublish:${userId}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}` },
        ],
      ],
    },
  };
  if (pending.duration) body.duration = pending.duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`, {
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

// وقتی روی «📤 ارسال به کانال» زدی (برای ویس): واقعاً می‌فرسته توی CHANNEL_ID
async function publishVoiceToChannel(env, chatId, pending) {
  const channelId = env.CHANNEL_ID;
  if (!channelId) {
    await sendMessage(
      env,
      chatId,
      "⚠️ متغیر CHANNEL_ID تنظیم نشده؛ توی wrangler.toml (بخش [vars]) آیدی عددی کانال رو اضافه کن (بات باید ادمین کانال هم باشه)."
    );
    return;
  }

  const body = {
    chat_id: channelId,
    voice: pending.file_id,
    reply_markup: {
      inline_keyboard: [[{ text: "⬇️ دانلود آهنگ", url: pending.link }]],
    },
  };
  if (pending.duration) body.duration = pending.duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`, {
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

  await deletePending(env, pending.admin_id);
  await sendMessage(env, chatId, "✅ توی کانال پست شد.");
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

  // ⚠️ عمداً هیچی توی جدول songs ثبت نمی‌کنیم — فقط بات اصلی (وقتی همین
  // آهنگ رو توی کانال آرشیو هم بذاری) مسئولِ ذخیره‌سازی توی دیتابیسه.
  // این بات فقط پستِ ظاهری رو توی کانال می‌ذاره.

  await deletePending(env, pending.admin_id);

  await sendMessage(
    env,
    chatId,
    "✅ توی کانال پست شد.\n\n⚠️ یادت نره همین آهنگ رو توی کانال آرشیو هم بذاری تا قابل جستجو بشه."
  );
}

// کلماتی که معمولا فقط «نوعِ نسخه» رو نشون می‌دن، نه خودِ اسم آهنگ رو —
// حذفشون می‌کنیم تا نسخه‌های مختلف (اصلی/اسپید/اسلو/ریمیکس/...) همه زیر
// یه کلید جستجوی مشترک قرار بگیرن
const VERSION_DESCRIPTORS = new Set([
  "slowed",
  "reverb",
  "sped",
  "speed",
  "up",
  "nightcore",
  "remix",
  "cover",
  "acoustic",
  "live",
  "instrumental",
  "extended",
  "bass",
  "boosted",
  "8d",
  "lyrics",
  "lyric",
  "video",
  "official",
  "audio",
  "hq",
  "hd",
  "clean",
  "explicit",
  "edit",
  "mix",
  "version",
  "ver",
  "slow",
  "fast",
  "deep",
  "night",
]);

// اسمِ «اصلیِ» آهنگ رو در میاره: هرچی داخل پرانتز/براکت باشه (معمولا توضیح
// نسخه‌ست) رو حذف می‌کنه، بعد کلمات توصیفیِ رایج بالا رو هم پاک می‌کنه
function extractCoreTitle(title) {
  if (!title) return "";
  let t = title.replace(/[([{][^)\]}]*[)\]}]/g, " "); // محتوای پرانتز/براکت
  const words = t.split(/\s+/).filter(Boolean);
  const filtered = words.filter((w) => {
    const lw = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    return lw && !VERSION_DESCRIPTORS.has(lw);
  });
  const core = filtered.join(" ").trim();
  return core || title; // اگه همه‌چی حذف شد (یعنی کل اسم توصیفی بود)، خودِ اصلی رو نگه دار
}

async function createSearchLink(env, query, performer) {
  const res = await env.DB.prepare(`INSERT INTO search_links (query, performer) VALUES (?1, ?2)`)
    .bind(query || "", performer || "")
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

async function setLink(env, userId, link) {
  await env.DB.prepare(`UPDATE pending_posts SET link = ?1 WHERE admin_id = ?2`)
    .bind(link, userId)
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
  return getOwnerIds(env).includes(String(userId));
}

function getOwnerIds(env) {
  return String(env.OWNER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// چنل خصوصیِ سومی که آرشیوِ بی‌کپشنِ همه‌ی آهنگ‌ها (با برچسبِ Forwarded from
// چنل اصلی) توش نگه‌داری می‌شه — علاوه بر ownerها، همینجا هم فوروارد می‌شه
function getForwardTargets(env) {
  const targets = [...getOwnerIds(env)];
  if (env.PRIVATE_ARCHIVE_CHANNEL_ID) {
    targets.push(String(env.PRIVATE_ARCHIVE_CHANNEL_ID));
  }
  return targets;
}

// ── هر آهنگی که توی کانال پست می‌شه (چه دستیِ ادمین‌ها، چه خودِ همین بات) ──
//
// تلگرام اجازه نمی‌ده «فوروارد واقعی» (با برچسب Forwarded from) کپشن
// نداشته باشه — فوروارد همیشه کپشنِ اصلی رو هم با خودش میاره. برای دور زدنِ
// این محدودیت: کپشنِ پستِ کانال رو یه لحظه خالی می‌کنیم، همون لحظه‌ی
// بی‌کپشن رو فوروارد می‌کنیم (برای هر owner، و برای چنل خصوصیِ سوم اگه
// PRIVATE_ARCHIVE_CHANNEL_ID ست شده باشه)، و بلافاصله کپشنِ اصلی رو روی
// پستِ کانال برمی‌گردونیم — طوری که بینندگانِ کانال هیچ چیزی رو از دست
// نمی‌دن.
async function handleChannelPost(msg, env) {
  const channelId = env.CHANNEL_ID;
  if (!channelId || String(msg.chat.id) !== String(channelId)) return;
  if (!msg.audio && !msg.voice) return; // فقط آهنگ‌ها و ویس‌ها رو فوروارد کن

  try {
    const originalCaption = msg.caption || "";
    const originalMarkup = msg.reply_markup || null;

    const stripResult = await editMessageCaption(env, channelId, msg.message_id, "", originalMarkup);
    if (!stripResult.ok) {
      // اگه نتونستیم کپشن رو ویرایش کنیم، احتمالا دسترسیِ «ویرایش پیام‌های
      // دیگران» رو توی کانال نداریم — به مالک خبر بده تا ساکت گم نشه
      for (const ownerId of getOwnerIds(env)) {
        await sendMessage(
          env,
          ownerId,
          `⚠️ نتونستم آهنگِ جدیدِ کانال رو فوروارد کنم.\nخطای تلگرام: ${stripResult.description || "نامشخص"}\n\nاحتمالا بات توی کانال دسترسیِ «Edit Messages of Others» رو نداره.`
        );
      }
      return;
    }

    for (const targetId of getForwardTargets(env)) {
      await forwardMessage(env, targetId, channelId, msg.message_id);
    }

    await editMessageCaption(env, channelId, msg.message_id, originalCaption, originalMarkup);
  } catch (e) {
    for (const ownerId of getOwnerIds(env)) {
      await sendMessage(env, ownerId, `⚠️ خطا توی فوروارد کردن آهنگِ کانال:\n${e.message || e}`);
    }
  }
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

// کپشنِ یه پیام رو ویرایش می‌کنه. reply_markup رو هم صریحاً دوباره پاس
// می‌دیم که دکمه‌ی شیشه‌ای زیر آهنگ حین این عملیات پاک نشه.
async function editMessageCaption(env, chatId, messageId, caption, reply_markup) {
  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/editMessageCaption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption, reply_markup }),
  });
  try {
    const data = await res.json();
    return { ok: !!data.ok, description: data.description || "" };
  } catch {
    return { ok: false, description: "پاسخ نامعتبر از تلگرام" };
  }
}

async function forwardMessage(env, chatId, fromChatId, messageId) {
  await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/forwardMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }),
  });
}
