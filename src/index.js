// بات دستیار پست‌گذاریِ NivaroMusic
//
// این بات تو چت خصوصی، فایل صوتی می‌گیره، کپشن می‌سازه، اختیاری دمو می‌گیره،
// و بعد از تاییدِ خودت:
//   - آهنگ رو تو «چنل اصلی» (env.CHANNEL_ID) پست می‌کنه
//   - رکورد رو تو دیتابیس مربوطه (فانک = env.DB یا انگلیسی = env.DB_EN) ذخیره می‌کنه
//   - دکمه‌ی شیشه‌ای می‌سازه که کاربر رو می‌بره تو بات اصلی برای گرفتن همون آهنگ
//
// دو دیتابیس:
//   env.DB    → song_search_db    (فانک)
//   env.DB_EN → song_search_db_en (انگلیسی)

const CAPTION_TEMPLATE = `🎧NivaroMusic

◈ ━━━━━━━━━━━━ ◈
◈ Name: {title}
◈ Artist: {performer}
◈ Tracks: {tracks}
◈ ━━━━━━━━━━━━ ◈

❝ Just close your eyes & feel it ❞

 🆔@NivaroMusic`;

const SEARCH_BUTTON_TEXT = "🎧 دریافت نسخه‌ی کامل";
const DEMO_BUTTON_TEXT = "🎧 دریافت نسخه‌ی کامل";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("ok");
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
      if (update.message) await handleMessage(update.message, env);
      else if (update.callback_query) await handleCallbackQuery(update.callback_query, env);
      else if (update.channel_post) await handleChannelPost(update.channel_post, env);
    } catch (e) {
      console.error("poster webhook error:", e);
    }
    return new Response("ok");
  },
};

// ── مسیریابی دیتابیس بر اساس src ─────────────────────────────
// "f" = فانک (env.DB)، "e" = انگلیسی (env.DB_EN)
function dbBySrc(env, src) {
  return src === "e" ? env.DB_EN : env.DB;
}

// پست همیشه تو «چنل اصلی» انجام می‌شه
function channelBySrc(env, src) {
  return env.CHANNEL_ID;
}

// ── پیام‌های خصوصی ───────────────────────────────────────────

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isOwner(env, userId)) {
    await sendMessage(env, chatId, "⛔️ این بات فقط برای خودِ صاحبش قابل استفاده‌ست.");
    return;
  }

  if (msg.text?.startsWith("/start")) {
    await sendMainMenu(env, chatId);
    return;
  }

  // پیام متنی (ویرایش یا لینک قدیمی)
  if (msg.text) {
    const pending = await getPendingAny(env, userId);
    if (pending && pending.awaiting_field && !pending.awaiting_field.startsWith("src:")) {
      const value = msg.text.trim();
      // حالت awaiting_field = "link" یا "link:src:X"
      if (pending.awaiting_field === "link" || pending.awaiting_field.startsWith("link:")) {
        await setLink(env, pending.__db, userId, value);
        await clearAwaitingField(env, pending.__db, userId);
        await sendVoiceFinalPreview(env, chatId, userId);
        return;
      }
      // حالت ویرایش title یا performer
      const fieldName = pending.awaiting_field.split(":")[0];
      await updatePendingField(env, pending.__db, userId, fieldName, value);
      await clearAwaitingField(env, pending.__db, userId);
      await sendPreview(env, chatId, userId, pending.src || "f");
      return;
    }
    await sendMainMenu(env, chatId);
    return;
  }

  if (msg.audio) {
    await handleIncomingAudio(msg, env);
    return;
  }

  if (msg.voice) {
    const pending = await getPendingAny(env, userId);
    if (pending && pending.status === "awaiting_demo") {
      await handleIncomingDemo(msg, env, pending);
    } else {
      await handleIncomingVoice(msg, env);
    }
    return;
  }

  await sendMessage(env, chatId, "یه فایل صوتی (audio) یا ویس بفرست 🎵");
}

async function sendMainMenu(env, chatId) {
  await sendMessage(env, chatId, "سلام 👋\nچیکار کنم؟", {
    inline_keyboard: [
      [{ text: "🎵 تک‌آهنگ فانک (با دمو)", callback_data: "flow:single:f" }],
      [{ text: "🎵 تک‌آهنگ انگلیسی (با دمو)", callback_data: "flow:single:e" }],
      [{ text: "🎧 آهنگ فانک (نسخه‌ها)", callback_data: "flow:normal:f" }],
      [{ text: "🎧 آهنگ انگلیسی (نسخه‌ها)", callback_data: "flow:normal:e" }],
    ],
  });
}

// ── فایل صوتی ────────────────────────────────────────────────

async function handleIncomingAudio(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const audio = msg.audio;

  const pending = await getPendingAny(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(env, chatId, "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه. اول اون رو جواب بده.");
    return;
  }

  const title = audio.title || stripExtension(audio.file_name) || "بدون عنوان";
  const performer = audio.performer || "نامشخص";

  // از pending قبلی، src و kind رو نگه دار
  const src = pending?.src || "f";
  const kind = pending?.kind === "single" ? "single" : "audio";
  const db = dbBySrc(env, src);

  await db.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link, demo_file_id, demo_duration)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'awaiting_confirm', ?8, NULL, NULL, NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       performer = excluded.performer,
       duration = excluded.duration,
       awaiting_field = excluded.awaiting_field,
       status = 'awaiting_confirm',
       kind = excluded.kind,
       link = NULL,
       demo_file_id = NULL,
       demo_duration = NULL`
  )
    .bind(
      userId,
      audio.file_id,
      audio.file_name || null,
      title,
      performer,
      audio.duration || null,
      `src:${src}`,
      kind
    )
    .run();

  await sendPreview(env, chatId, userId, src);
}

// ── دمو ──────────────────────────────────────────────────────

async function handleIncomingDemo(msg, env, pending) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const voice = msg.voice;
  const src = pending.src || "f";
  const db = dbBySrc(env, src);

  await db.prepare(
    `UPDATE pending_posts
     SET demo_file_id = ?1, demo_duration = ?2, status = 'awaiting_publish'
     WHERE admin_id = ?3`
  )
    .bind(voice.file_id, voice.duration || null, userId)
    .run();

  const updated = await getPendingAny(env, userId);
  await sendDemoFinalPreview(env, chatId, userId, updated);
}

// ── ویس قدیمی ────────────────────────────────────────────────

async function handleIncomingVoice(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const voice = msg.voice;

  const pending = await getPendingAny(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(env, chatId, "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه.");
    return;
  }

  const src = pending?.src || "f";
  const db = dbBySrc(env, src);

  await db.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link, demo_file_id, demo_duration)
     VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4, 'awaiting_confirm', 'voice', NULL, NULL, NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id, file_name = NULL, title = NULL, performer = NULL,
       duration = excluded.duration, awaiting_field = excluded.awaiting_field,
       status = 'awaiting_confirm', kind = 'voice', link = NULL,
       demo_file_id = NULL, demo_duration = NULL`
  )
    .bind(userId, voice.file_id, voice.duration || null, `link:src:${src}`)
    .run();

  await sendMessage(env, chatId, "🔗 لینک دانلود رو بفرست تا زیرِ ویس دکمه‌اش کنم:");
}

// ── پیش‌نمایش کپشن ────────────────────────────────────────────

async function sendPreview(env, chatId, userId, src) {
  const pending = await getPendingAny(env, userId);
  if (!pending) return;

  const caption = buildCaption(pending.title, pending.performer, pending.kind);
  const text = `پیش‌نمایش کپشن (دیتابیس: ${src === "e" ? "انگلیسی" : "فانک"}):\n\n${caption}\n\nهمه‌چی درسته؟`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "✅ تایید و ادامه", callback_data: `pconfirm:${userId}:${src}` }],
      [
        { text: "✏️ ویرایش عنوان", callback_data: `pedit_t:${userId}:${src}` },
        { text: "✏️ ویرایش خواننده", callback_data: `pedit_p:${userId}:${src}` },
      ],
      [{ text: "❌ انصراف", callback_data: `pcancel:${userId}:${src}` }],
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
  const src = parts[2] || "f";

  if (!chatId || !isOwner(env, userId)) {
    await answerCallbackQuery(env, cq.id, "⛔️ اجازه نداری.");
    return;
  }
  if (ownerId && ownerId !== userId) {
    await answerCallbackQuery(env, cq.id, "این پیام مال تو نیست.");
    return;
  }

  // شروع فلوی «تک‌آهنگ»
  if (action === "flow" && parts[1] === "single") {
    await answerCallbackQuery(env, cq.id);
    const db = dbBySrc(env, src);
    await db.prepare(
      `INSERT INTO pending_posts (admin_id, status, kind, file_id, title, performer, demo_file_id, demo_duration, awaiting_field, link)
       VALUES (?1, 'awaiting_full', 'single', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(admin_id) DO UPDATE SET
         file_id = NULL, title = NULL, performer = NULL,
         demo_file_id = NULL, demo_duration = NULL,
         status = 'awaiting_full', kind = 'single',
         awaiting_field = NULL, link = NULL`
    )
      .bind(userId)
      .run();
    await sendMessage(env, chatId, `🎵 آهنگ کامل رو بفرست (دیتابیس: ${src === "e" ? "انگلیسی" : "فانک"}) (audio):`);
    return;
  }

  // شروع فلوی «عادی»
  if (action === "flow" && parts[1] === "normal") {
    await answerCallbackQuery(env, cq.id);
    const db = dbBySrc(env, src);
    await db.prepare(
      `INSERT INTO pending_posts (admin_id, status, kind, file_id, title, performer, demo_file_id, demo_duration, awaiting_field, link)
       VALUES (?1, 'awaiting_full', 'audio', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(admin_id) DO UPDATE SET
         file_id = NULL, title = NULL, performer = NULL,
         demo_file_id = NULL, demo_duration = NULL,
         status = 'awaiting_full', kind = 'audio',
         awaiting_field = NULL, link = NULL`
    )
      .bind(userId)
      .run();
    await sendMessage(env, chatId, `🎧 آهنگ رو بفرست (دیتابیس: ${src === "e" ? "انگلیسی" : "فانک"}) (audio):`);
    return;
  }

  const pending = await getPendingAny(env, userId);
  if (!pending) {
    await answerCallbackQuery(env, cq.id, "چیزی برای ادامه نیست.");
    return;
  }
  const db = dbBySrc(env, src);

  if (action === "pcancel") {
    await deletePending(env, db, userId);
    await answerCallbackQuery(env, cq.id, "لغو شد.");
    await sendMessage(env, chatId, "❌ لغو شد.");
    return;
  }

  if (action === "pedit_t" || action === "pedit_p") {
    const field = action === "pedit_t" ? "title" : "performer";
    await setAwaitingField(env, db, userId, field);
    await answerCallbackQuery(env, cq.id);
    await sendMessage(env, chatId, field === "title" ? "اسم جدید آهنگ:" : "اسم جدید خواننده:");
    return;
  }

  if (action === "pconfirm") {
    await answerCallbackQuery(env, cq.id);
    if (pending.kind === "single") {
      await db.prepare(`UPDATE pending_posts SET status = 'awaiting_demo' WHERE admin_id = ?1`)
        .bind(userId)
        .run();
      await sendMessage(env, chatId, "✅ کپشن تایید شد.\nحالا دمو رو بفرست (فقط voice):");
      return;
    }
    await sendFinalPreview(env, chatId, userId, pending, src);
    return;
  }

  if (action === "ppublish") {
    await answerCallbackQuery(env, cq.id);
    await publishToChannel(env, chatId, pending, src);
    return;
  }

  if (action === "vpublish") {
    await answerCallbackQuery(env, cq.id);
    await publishVoiceToChannel(env, chatId, pending, src);
    return;
  }

  if (action === "dpublish") {
    await answerCallbackQuery(env, cq.id);
    await publishDemoToChannel(env, chatId, pending, src);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ── پیش‌نمایش نهایی (عادی) ───────────────────────────────────

async function sendFinalPreview(env, chatId, userId, pending, src) {
  const botUsername = env.MAIN_BOT_USERNAME;
  if (!botUsername) {
    await sendMessage(env, chatId, "⚠️ MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const db = dbBySrc(env, src);
  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, db, searchQuery, pending.performer);

  const caption = buildCaption(pending.title, pending.performer, pending.kind);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  const body = {
    chat_id: chatId,
    audio: pending.file_id,
    caption,
    title: pending.title,
    performer: pending.performer,
    reply_markup: {
      inline_keyboard: [
        [{ text: SEARCH_BUTTON_TEXT, url: deepLink }],
        [
          { text: "📤 ارسال به کانال", callback_data: `ppublish:${userId}:${src}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}:${src}` },
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
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  await setStatus(env, db, userId, "awaiting_publish");
  await sendMessage(env, chatId, "ارسالش کنم؟");
}

// ── پیش‌نمایش نهایی (تک‌آهنگ) ─────────────────────────────────

async function sendDemoFinalPreview(env, chatId, userId, pending) {
  if (!pending) return;

  const botUsername = env.MAIN_BOT_USERNAME;
  if (!botUsername) {
    await sendMessage(env, chatId, "⚠️ MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const src = pending.src || "f";
  const db = dbBySrc(env, src);
  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, db, searchQuery, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  // ۱) آهنگ کامل
  const audioCaption = buildCaption(pending.title, pending.performer, pending.kind);
  await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      audio: pending.file_id,
      caption: audioCaption,
      title: pending.title,
      performer: pending.performer,
      duration: pending.duration || undefined,
    }),
  });

  // ۲) دمو با دکمه
  const demoCaption =
    `🎬 ${pending.title} - ${pending.performer}\n\n` +
    `🎧 برای دریافت نسخه‌ی کامل دکمه‌ی زیر رو بزن 👇`;

  const body = {
    chat_id: chatId,
    voice: pending.demo_file_id,
    caption: demoCaption,
    reply_markup: {
      inline_keyboard: [
        [{ text: DEMO_BUTTON_TEXT, url: deepLink }],
        [
          { text: "📤 ارسال به کانال", callback_data: `dpublish:${userId}:${src}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}:${src}` },
        ],
      ],
    },
  };
  if (pending.demo_duration) body.duration = pending.demo_duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  await setStatus(env, db, userId, "awaiting_publish");
  await sendMessage(env, chatId, "ارسالش کنم؟");
}

// ── پیش‌نمایش نهایی ویس ──────────────────────────────────────

async function sendVoiceFinalPreview(env, chatId, userId) {
  const pending = await getPendingAny(env, userId);
  if (!pending) return;
  const src = pending.src || "f";

  const body = {
    chat_id: chatId,
    voice: pending.file_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "⬇️ دانلود آهنگ", url: pending.link }],
        [
          { text: "📤 ارسال به کانال", callback_data: `vpublish:${userId}:${src}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}:${src}` },
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
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  const db = dbBySrc(env, src);
  await setStatus(env, db, userId, "awaiting_publish");
  await sendMessage(env, chatId, "ارسالش کنم؟");
}

// ── ارسال به کانال (ویس) ─────────────────────────────────────

async function publishVoiceToChannel(env, chatId, pending, src) {
  const channelId = channelBySrc(env, src);
  if (!channelId) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID تنظیم نشده");
    return;
  }

  const body = {
    chat_id: channelId,
    voice: pending.file_id,
    reply_markup: { inline_keyboard: [[{ text: "⬇️ دانلود آهنگ", url: pending.link }]] },
  };
  if (pending.duration) body.duration = pending.duration;

  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  const db = dbBySrc(env, src);
  await deletePending(env, db, pending.admin_id);
  await sendMessage(env, chatId, "✅ توی کانال پست شد.");
}

// ── ارسال به کانال (عادی) ────────────────────────────────────

async function publishToChannel(env, chatId, pending, src) {
  const channelId = channelBySrc(env, src);
  const botUsername = env.MAIN_BOT_USERNAME;
  const db = dbBySrc(env, src);

  if (!channelId) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID تنظیم نشده");
    return;
  }

  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, db, searchQuery, pending.performer);
  const caption = buildCaption(pending.title, pending.performer, pending.kind);
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
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  // ثبت تو دیتابیس مربوطه
  await db.prepare(
    `INSERT INTO songs (chat_id, message_id, title, performer, file_name, caption, duration, group_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
     ON CONFLICT(message_id) DO UPDATE SET
       chat_id = excluded.chat_id, title = excluded.title,
       performer = excluded.performer, file_name = excluded.file_name,
       caption = excluded.caption, duration = excluded.duration`
  )
    .bind(channelId, data.result.message_id, pending.title, pending.performer, pending.file_name, caption, pending.duration)
    .run();

  await deletePending(env, db, pending.admin_id);
  await sendMessage(env, chatId, "✅ آهنگ تو کانال پست و تو دیتابیس ذخیره شد.");
}

// ── ارسال به کانال (تک‌آهنگ + دمو) ───────────────────────────

async function publishDemoToChannel(env, chatId, pending, src) {
  const channelId = channelBySrc(env, src);
  const botUsername = env.MAIN_BOT_USERNAME;
  const db = dbBySrc(env, src);

  if (!channelId || !botUsername) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID یا MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, db, searchQuery, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  // ۱) آهنگ کامل
  const audioCaption = buildCaption(pending.title, pending.performer, pending.kind);
  const audioRes = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      audio: pending.file_id,
      caption: audioCaption,
      title: pending.title,
      performer: pending.performer,
      duration: pending.duration || undefined,
    }),
  });
  const audioData = await audioRes.json();
  if (!audioData.ok) {
    await sendMessage(env, chatId, `❌ خطا در پست آهنگ: ${audioData.description}`);
    return;
  }

  // ۲) دمو با دکمه
  const demoCaption =
    `🎬 ${pending.title} - ${pending.performer}\n\n` +
    `🎧 برای دریافت نسخه‌ی کامل دکمه‌ی زیر رو بزن 👇`;

  const voiceRes = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      voice: pending.demo_file_id,
      caption: demoCaption,
      duration: pending.demo_duration || undefined,
      reply_markup: { inline_keyboard: [[{ text: DEMO_BUTTON_TEXT, url: deepLink }]] },
    }),
  });
  const voiceData = await voiceRes.json();
  if (!voiceData.ok) {
    await sendMessage(env, chatId, `❌ خطا در پست دمو: ${voiceData.description}`);
    return;
  }

  // ۳) ثبت آهنگ کامل تو دیتابیس مربوطه
  await db.prepare(
    `INSERT INTO songs (chat_id, message_id, title, performer, file_name, caption, duration, group_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
     ON CONFLICT(message_id) DO UPDATE SET
       chat_id = excluded.chat_id, title = excluded.title,
       performer = excluded.performer, file_name = excluded.file_name,
       caption = excluded.caption, duration = excluded.duration`
  )
    .bind(channelId, audioData.result.message_id, pending.title, pending.performer, pending.file_name, audioCaption, pending.duration)
    .run();

  await deletePending(env, db, pending.admin_id);
  await sendMessage(env, chatId, "✅ آهنگ + دمو تو کانال پست و تو دیتابیس ذخیره شد.");
}

// ── کمکی: عنوان اصلی ─────────────────────────────────────────

const VERSION_DESCRIPTORS = new Set([
  "slowed", "reverb", "sped", "speed", "up", "nightcore", "remix",
  "cover", "acoustic", "live", "instrumental", "extended", "bass",
  "boosted", "8d", "lyrics", "lyric", "video", "official", "audio",
  "hq", "hd", "clean", "explicit", "edit", "mix", "version", "ver",
  "slow", "fast", "deep", "night",
]);

function extractCoreTitle(title) {
  if (!title) return "";
  let t = title.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const filtered = words.filter((w) => {
    const lw = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    return lw && !VERSION_DESCRIPTORS.has(lw);
  });
  const core = filtered.join(" ").trim();
  return core || title;
}

async function createSearchLink(env, db, query, performer) {
  const res = await db.prepare(
    `INSERT INTO search_links (query, performer) VALUES (?1, ?2)`
  )
    .bind(query || "", performer || "")
    .run();
  return res.meta.last_row_id;
}

// ── دسترسی به pending_posts (تو هر دو دیتابیس) ────────────────

async function getPendingAny(env, userId) {
  // اول تو دیتابیس فانک
  const p1 = await env.DB.prepare(`SELECT * FROM pending_posts WHERE admin_id = ?1`)
    .bind(userId)
    .first();
  if (p1) {
    p1.__db = env.DB;
    p1.src = extractSrc(p1.awaiting_field) || "f";
    return p1;
  }
  // بعد تو انگلیسی
  if (env.DB_EN) {
    const p2 = await env.DB_EN.prepare(`SELECT * FROM pending_posts WHERE admin_id = ?1`)
      .bind(userId)
      .first();
    if (p2) {
      p2.__db = env.DB_EN;
      p2.src = extractSrc(p2.awaiting_field) || "e";
      return p2;
    }
  }
  return null;
}

function extractSrc(awaitingField) {
  if (!awaitingField) return null;
  if (awaitingField.startsWith("src:")) return awaitingField.slice(4);
  const idx = awaitingField.indexOf(":src:");
  if (idx >= 0) return awaitingField.slice(idx + 5);
  return null;
}

async function updatePendingField(env, db, userId, field, value) {
  const col = field === "title" ? "title" : "performer";
  await db.prepare(`UPDATE pending_posts SET ${col} = ?1 WHERE admin_id = ?2`)
    .bind(value, userId)
    .run();
}

async function setLink(env, db, userId, link) {
  await db.prepare(`UPDATE pending_posts SET link = ?1 WHERE admin_id = ?2`)
    .bind(link, userId)
    .run();
}

async function setAwaitingField(env, db, userId, field) {
  // src رو نگه دار
  const current = await db.prepare(`SELECT awaiting_field FROM pending_posts WHERE admin_id = ?1`)
    .bind(userId)
    .first();
  const src = extractSrc(current?.awaiting_field) || "f";
  await db.prepare(`UPDATE pending_posts SET awaiting_field = ?1 WHERE admin_id = ?2`)
    .bind(`${field}:src:${src}`, userId)
    .run();
}

async function clearAwaitingField(env, db, userId) {
  await db.prepare(`UPDATE pending_posts SET awaiting_field = NULL WHERE admin_id = ?1`)
    .bind(userId)
    .run();
}

async function setStatus(env, db, userId, status) {
  await db.prepare(`UPDATE pending_posts SET status = ?1 WHERE admin_id = ?2`)
    .bind(status, userId)
    .run();
}

async function deletePending(env, db, userId) {
  await db.prepare(`DELETE FROM pending_posts WHERE admin_id = ?1`).bind(userId).run();
}

// ── کمکی: دسترسی ──────────────────────────────────────────────

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

function getForwardTargets(env) {
  const targets = [...getOwnerIds(env)];
  if (env.PRIVATE_ARCHIVE_CHANNEL_ID) {
    targets.push(String(env.PRIVATE_ARCHIVE_CHANNEL_ID));
  }
  return targets;
}

// ── فوروارد خودکار پیام‌های چنل اصلی به owner و آرشیو خصوصی ──

async function handleChannelPost(msg, env) {
  const channelId = env.CHANNEL_ID;
  if (!channelId || String(msg.chat.id) !== String(channelId)) return;
  if (!msg.audio && !msg.voice) return;

  for (const targetId of getForwardTargets(env)) {
    try {
      const fwResult = await forwardMessage(env, targetId, channelId, msg.message_id);
      if (!fwResult.ok) {
        for (const ownerId of getOwnerIds(env)) {
          await sendMessage(
            env,
            ownerId,
            `⚠️ فوروارد به ${targetId} با خطا مواجه شد:\n${fwResult.description || "نامشخص"}`
          );
        }
        continue;
      }
      const forwardedMessageId = fwResult.result && fwResult.result.message_id;
      if (forwardedMessageId) {
        const stripResult = await editMessageCaption(env, targetId, forwardedMessageId, "", null);
        if (!stripResult.ok) {
          for (const ownerId of getOwnerIds(env)) {
            await sendMessage(
              env,
              ownerId,
              `⚠️ فوروارد به ${targetId} انجام شد ولی نتونستم کپشنش رو پاک کنم:\n${stripResult.description || "نامشخص"}`
            );
          }
        }
      }
    } catch (e) {
      for (const ownerId of getOwnerIds(env)) {
        await sendMessage(env, ownerId, `⚠️ خطا توی فوروارد به ${targetId}:\n${e.message || e}`);
      }
    }
  }
}

// ── ساخت کپشن ────────────────────────────────────────────────

function buildCaption(title, performer, kind) {
  const tracks = "1";
  return CAPTION_TEMPLATE.split("{title}")
    .join(title || "")
    .split("{performer}")
    .join(performer || "")
    .split("{tracks}")
    .join(tracks);
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
  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/forwardMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }),
  });
  try {
    const data = await res.json();
    return { ok: !!data.ok, description: data.description || "", result: data.result || null };
  } catch {
    return { ok: false, description: "پاسخ نامعتبر از تلگرام", result: null };
  }
}
