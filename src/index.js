// بات دستیار پست‌گذاریِ NivaroMusic — پروژه‌ی کاملا جدا (Worker مستقل)
//
// این پروژه هیچ ربطی به ریپو/بات اصلی نداره: توکن جدا، ریپوی گیت‌هاب جدا،
// دیپلوی جدا. تنها چیزی که با بات اصلی مشترکه، همون دیتابیس D1 هست.
//
// دو حالت داره:
// 1) 🎵 تک‌آهنگ (با دمو) — آهنگ کامل رو می‌گیری، کپشن می‌سازی، بعد دمو رو
//    می‌گیری، و هر دو رو تو کانال پست می‌کنی. دمو یه دکمه‌ی شیشه‌ای داره
//    که کاربر رو می‌بره تو بات اصلی و فقط همون آهنگ رو براش می‌فرسته.
// 2) 🎧 آهنگ عادی (نسخه‌ها) — مثل قبل، آهنگ رو با دکمه‌ی «نسخه‌های دیگه» پست می‌کنه.

// 👇👇 کپشن دلخواهت — {title}، {performer}، {tracks} خودکار جایگزین می‌شن.
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
    await sendMainMenu(env, chatId);
    return;
  }

  // پیام متنی — یا ویرایش عنوان/خواننده، یا گرفتن لینک (فلوی قدیمی ویس)
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
    await sendMainMenu(env, chatId);
    return;
  }

  // فایل صوتی (audio) — مرحله ۱
  if (msg.audio) {
    await handleIncomingAudio(msg, env);
    return;
  }

  // ویس (voice) — اگه تو فلوی تک‌آهنگ منتظر دمو هستیم، دمو، وگرنه فلوی قدیمی
  if (msg.voice) {
    const pending = await getPending(env, userId);
    if (pending && pending.status === "awaiting_demo") {
      await handleIncomingDemo(msg, env, pending);
    } else {
      await handleIncomingVoice(msg, env);
    }
    return;
  }

  await sendMessage(env, chatId, "یه فایل صوتی (audio) یا ویس بفرست 🎵");
}

// منوی اصلی با دکمه‌ها
async function sendMainMenu(env, chatId) {
  await sendMessage(env, chatId, "سلام 👋\nچیکار کنم؟", {
    inline_keyboard: [
      [{ text: "🎵 تک‌آهنگ (با دمو)", callback_data: "flow:single:0" }],
      [{ text: "🎧 آهنگ عادی (نسخه‌ها)", callback_data: "flow:normal:0" }],
    ],
  });
}

// ── فلوی تک‌آهنگ: مرحله ۱ (آهنگ کامل) ─────────────────────────

async function handleIncomingAudio(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const audio = msg.audio;

  const pending = await getPending(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(
      env,
      chatId,
      "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه. اول اون رو جواب بده."
    );
    return;
  }

  const title = audio.title || stripExtension(audio.file_name) || "بدون عنوان";
  const performer = audio.performer || "نامشخص";

  // فلوی فعلی: اگه pending.kind == 'single' بود، ادامه‌ی همون فلوی تک‌آهنگ
  const flow = pending?.kind === "single" ? "single" : "audio";

  await env.DB.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link, demo_file_id, demo_duration)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'awaiting_confirm', ?7, NULL, NULL, NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       performer = excluded.performer,
       duration = excluded.duration,
       awaiting_field = NULL,
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
      flow
    )
    .run();

  await sendPreview(env, chatId, userId);
}

// ── فلوی تک‌آهنگ: مرحله ۲ (دمو) ──────────────────────────────

async function handleIncomingDemo(msg, env, pending) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const voice = msg.voice;

  await env.DB.prepare(
    `UPDATE pending_posts
     SET demo_file_id = ?1, demo_duration = ?2, status = 'awaiting_publish'
     WHERE admin_id = ?3`
  )
    .bind(voice.file_id, voice.duration || null, userId)
    .run();

  const updated = await getPending(env, userId);
  await sendDemoFinalPreview(env, chatId, userId, updated);
}

// ── فلوی قدیمی ویس (ویس + لینک دستی) ──────────────────────────

async function handleIncomingVoice(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const voice = msg.voice;

  const pending = await getPending(env, userId);
  if (pending && pending.status === "awaiting_publish") {
    await sendMessage(
      env,
      chatId,
      "⚠️ یه پستِ قبلی هنوز منتظر تصمیم توئه. اول اون رو جواب بده، بعد فایل جدید بفرست."
    );
    return;
  }

  await env.DB.prepare(
    `INSERT INTO pending_posts (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, kind, link, demo_file_id, demo_duration)
     VALUES (?1, ?2, NULL, NULL, NULL, ?3, 'link', 'awaiting_confirm', 'voice', NULL, NULL, NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = NULL,
       title = NULL,
       performer = NULL,
       duration = excluded.duration,
       awaiting_field = 'link',
       status = 'awaiting_confirm',
       kind = 'voice',
       link = NULL,
       demo_file_id = NULL,
       demo_duration = NULL`
  )
    .bind(userId, voice.file_id, voice.duration || null)
    .run();

  await sendMessage(env, chatId, "🔗 لینک دانلود رو بفرست تا زیرِ ویس دکمه‌اش کنم:");
}

// ── پیش‌نمایش کپشن (برای فلوی عادی و تک‌آهنگ) ─────────────────

async function sendPreview(env, chatId, userId) {
  const pending = await getPending(env, userId);
  if (!pending) return;

  const caption = buildCaption(pending.title, pending.performer, pending.kind);
  const text = `پیش‌نمایش کپشن:\n\n${caption}\n\nهمه‌چی درسته؟`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "✅ تایید و ادامه", callback_data: `pconfirm:${userId}` }],
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
  if (ownerId && ownerId !== userId) {
    await answerCallbackQuery(env, cq.id, "این پیام مال تو نیست.");
    return;
  }

  // ── شروع فلوی «تک‌آهنگ (با دمو)» ──
  if (action === "flow" && parts[1] === "single") {
    await answerCallbackQuery(env, cq.id);
    await env.DB.prepare(
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
    await sendMessage(env, chatId, "🎵 آهنگ کامل رو بفرست (audio):");
    return;
  }

  // ── شروع فلوی «آهنگ عادی (نسخه‌ها)» ──
  if (action === "flow" && parts[1] === "normal") {
    await answerCallbackQuery(env, cq.id);
    await env.DB.prepare(
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
    await sendMessage(env, chatId, "🎧 آهنگ رو بفرست (audio):");
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

    // فلوی تک‌آهنگ ⇒ برو مرحله‌ی گرفتن دمو
    if (pending.kind === "single") {
      await env.DB.prepare(
        `UPDATE pending_posts SET status = 'awaiting_demo' WHERE admin_id = ?1`
      )
        .bind(userId)
        .run();
      await sendMessage(
        env,
        chatId,
        "✅ کپشن تایید شد.\nحالا دمو رو بفرست (فقط voice):"
      );
      return;
    }

    // فلوی عادی ⇒ پیش‌نمایش نهایی
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

  // ── تایید نهایی فلوی تک‌آهنگ: ارسال هر دو به کانال ──
  if (action === "dpublish") {
    await answerCallbackQuery(env, cq.id);
    await publishDemoToChannel(env, chatId, pending);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ── پیش‌نمایش نهایی فلوی عادی ────────────────────────────────

async function sendFinalPreview(env, chatId, userId, pending) {
  const botUsername = env.MAIN_BOT_USERNAME;
  if (!botUsername) {
    await sendMessage(env, chatId, "⚠️ MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, searchQuery, pending.performer);

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
  await sendMessage(env, chatId, "این بالا دقیقا همون چیزیه که تو کانال پست می‌شه. ارسالش کنم؟");
}

// ── پیش‌نمایش نهایی فلوی تک‌آهنگ (آهنگ + دمو + دکمه) ────────────

async function sendDemoFinalPreview(env, chatId, userId, pending) {
  if (!pending) return;

  const botUsername = env.MAIN_BOT_USERNAME;
  if (!botUsername) {
    await sendMessage(env, chatId, "⚠️ MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, searchQuery, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  // ۱) آهنگ کامل (به‌عنوان پیش‌نمایش)
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

  // ۲) دمو با دکمه‌ی نهایی
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
          { text: "📤 ارسال به کانال", callback_data: `dpublish:${userId}:${linkId}` },
          { text: "❌ انصراف", callback_data: `pcancel:${userId}` },
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

  await setStatus(env, userId, "awaiting_publish");
  await sendMessage(
    env,
    chatId,
    "این بالا دقیقا همون چیزیه که تو کانال پست می‌شه. ارسالش کنم؟"
  );
}

// ── پیش‌نمایش نهایی ویس (فلوی قدیمی) ─────────────────────────

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
  await sendMessage(env, chatId, "این بالا دقیقا همون چیزیه که تو کانال پست می‌شه. ارسالش کنم؟");
}

// ── ارسال ویس قدیمی به کانال ─────────────────────────────────

async function publishVoiceToChannel(env, chatId, pending) {
  const channelId = env.CHANNEL_ID;
  if (!channelId) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID تنظیم نشده");
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
    await sendMessage(env, chatId, `❌ خطا: ${data.description || "نامشخص"}`);
    return;
  }

  await deletePending(env, pending.admin_id);
  await sendMessage(env, chatId, "✅ توی کانال پست شد.");
}

// ── ارسال نهایی فلوی عادی به کانال ───────────────────────────

async function publishToChannel(env, chatId, pending, linkId) {
  const channelId = env.CHANNEL_ID;
  const botUsername = env.MAIN_BOT_USERNAME;

  if (!channelId) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID تنظیم نشده");
    return;
  }

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

  await deletePending(env, pending.admin_id);
  await sendMessage(
    env,
    chatId,
    "✅ توی کانال پست شد.\n\n⚠️ یادت نره همین آهنگ رو توی کانال آرشیو هم بذاری تا قابل جستجو بشه."
  );
}

// ── ارسال نهایی فلوی تک‌آهنگ: اول آهنگ، بعد دمو با دکمه ────────

async function publishDemoToChannel(env, chatId, pending) {
  const channelId = env.CHANNEL_ID;
  const botUsername = env.MAIN_BOT_USERNAME;
  if (!channelId || !botUsername) {
    await sendMessage(env, chatId, "⚠️ CHANNEL_ID یا MAIN_BOT_USERNAME تنظیم نشده");
    return;
  }

  const coreTitle = extractCoreTitle(pending.title);
  const searchQuery = [coreTitle, pending.performer].filter(Boolean).join(" ").trim();
  const linkId = await createSearchLink(env, searchQuery, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=q_${linkId}`;

  // ۱) آهنگ کامل
  const audioCaption = buildCaption(pending.title, pending.performer, pending.kind);
  const audioRes = await fetch(
    `https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendAudio`,
    {
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
    }
  );
  const audioData = await audioRes.json();
  if (!audioData.ok) {
    await sendMessage(env, chatId, `❌ خطا در پست آهنگ: ${audioData.description}`);
    return;
  }

  // ۲) دمو با دکمه
  const demoCaption =
    `🎬 ${pending.title} - ${pending.performer}\n\n` +
    `🎧 برای دریافت نسخه‌ی کامل دکمه‌ی زیر رو بزن 👇`;

  const voiceRes = await fetch(
    `https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/sendVoice`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        voice: pending.demo_file_id,
        caption: demoCaption,
        duration: pending.demo_duration || undefined,
        reply_markup: {
          inline_keyboard: [[{ text: DEMO_BUTTON_TEXT, url: deepLink }]],
        },
      }),
    }
  );
  const voiceData = await voiceRes.json();
  if (!voiceData.ok) {
    await sendMessage(env, chatId, `❌ خطا در پست دمو: ${voiceData.description}`);
    return;
  }

  // ۳) ثبت آهنگ کامل تو دیتابیس (تا بات اصلی پیداش کنه)
  await env.DB.prepare(
    `INSERT INTO songs (chat_id, message_id, title, performer, file_name, caption, duration, group_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
     ON CONFLICT(message_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       title = excluded.title,
       performer = excluded.performer,
       file_name = excluded.file_name,
       caption = excluded.caption,
       duration = excluded.duration`
  )
    .bind(
      channelId,
      audioData.result.message_id,
      pending.title,
      pending.performer,
      pending.file_name,
      audioCaption,
      pending.duration
    )
    .run();

  await deletePending(env, pending.admin_id);
  await sendMessage(
    env,
    chatId,
    "✅ آهنگ کامل + دمو با دکمه‌ی شیشه‌ای تو کانال پست شدن."
  );
}

// ── کمکی: کلماتی که «نوع نسخه» رو نشون می‌دن ──────────────────

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

async function createSearchLink(env, query, performer) {
  const res = await env.DB.prepare(
    `INSERT INTO search_links (query, performer) VALUES (?1, ?2)`
  )
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

// ── کمکی: دسترسی ادمین ────────────────────────────────────────

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

// ── فوروارد خودکار پیام‌های کانال به owner و آرشیو خصوصی ───────

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
        await sendMessage(
          env,
          ownerId,
          `⚠️ خطا توی فوروارد کردن آهنگِ کانال به ${targetId}:\n${e.message || e}`
        );
      }
    }
  }
}

// ── ساخت کپشن ────────────────────────────────────────────────

function buildCaption(title, performer, kind) {
  const tracks = "1"; // هر آهنگ خودش یک ترک
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
