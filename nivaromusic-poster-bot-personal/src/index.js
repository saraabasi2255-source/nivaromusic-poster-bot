// بات دستیار شخصی NivaroMusic — پروژه‌ی کاملا جدا (Worker مستقل)
//
// این پروژه هیچ ربطی به ریپو/بات اصلی نداره: توکن جدا، ریپوی گیت‌هاب جدا،
// دیپلوی جدا. تنها چیزی که با بات اصلی مشترکه، همون دیتابیس D1 هست (چون
// باید بتونه آهنگ‌های قبلی رو برای تشخیص «نسخه» جستجو کنه و رکورد جدید رو
// جوری بنویسه که بات اصلی هم ببینتش) — در README توضیح داده شده چطور
// دیتابیسِ پروژه‌ی اول رو به این پروژه هم وصل کنی.
//
// کارش: توی چت خصوصی (فقط برای OWNER_ID خودت) یه فایل صوتی می‌گیره، کپشن رو
// طبق CAPTION_TEMPLATE پایین همین فایل می‌سازه، می‌پرسه این نسخه‌ی جدیدِ
// کدوم آهنگه یا کاملا جدیده، و در نهایت فایل صوتی رو با کپشن کامل +
// دکمه‌ی شیشه‌ای «نسخه‌های دیگه‌ی این آهنگ» فقط برای خودِ همون کاربر
// (توی همون چت خصوصی) می‌فرسته. هیچ‌جای دیگه‌ای (کانال یا هرکسِ دیگه)
// چیزی پست نمی‌شه.

// 👇👇 کپشن دلخواهت (فرمت خودت) — {title} و {performer} خودکار جایگزین می‌شن.
const CAPTION_TEMPLATE = `NivaroMusic

◈ ━━━━━━━━━━━━ ◈
◈ Track : {title}
◈ Artist : {performer}
◈ ━━━━━━━━━━━━ ◈

❝ Just close your eyes & feel it ❞

 @NivaroMusic`;

const VERSIONS_BUTTON_TEXT = "🎧 نسخه‌های دیگه‌ی این آهنگ";

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
      "سلام 👋\nهر فایل صوتی که برام بفرستی رو با کپشن آماده و دکمه‌ی «نسخه‌های دیگه» برات همینجا برمی‌گردونم (جای دیگه‌ای پست نمی‌شه)."
    );
    return;
  }

  // اگه منتظر ویرایش دستیِ عنوان/خواننده یا تغییر متن جستجو هستیم، این پیام متنی همونه
  if (msg.text) {
    const pending = await getPending(env, userId);
    if (pending && pending.awaiting_field) {
      const value = msg.text.trim();
      const field = pending.awaiting_field;
      await updatePendingField(env, userId, field, value);
      await clearAwaitingField(env, userId);

      if (field === "search_query") {
        await showGroupPicker(env, chatId, userId);
      } else {
        await sendPreview(env, chatId, userId);
      }
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

  const title = audio.title || stripExtension(audio.file_name) || "بدون عنوان";
  const performer = audio.performer || "نامشخص";

  await env.DB.prepare(
    `INSERT INTO pending_posts
       (admin_id, file_id, file_name, title, performer, duration, awaiting_field, status, selected_ids, search_query, picker_message_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'awaiting_confirm', '[]', NULL, NULL)
     ON CONFLICT(admin_id) DO UPDATE SET
       file_id = excluded.file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       performer = excluded.performer,
       duration = excluded.duration,
       awaiting_field = NULL,
       status = 'awaiting_confirm',
       selected_ids = '[]',
       search_query = NULL,
       picker_message_id = NULL`
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

  // امنیت: فقط خودِ ادمینی که این پست رو شروع کرده می‌تونه دکمه‌هاشو بزنه
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
    await sendMessage(env, chatId, "❌ لغو شد.");
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
    // اولین بار: کلمه‌ی جستجو رو با عنوان آهنگ پر کن
    if (!pending.search_query) {
      await updatePendingField(env, userId, "search_query", pending.title || "");
    }
    await showGroupPicker(env, chatId, userId);
    return;
  }

  if (action === "ptoggle") {
    const songId = Number(parts[2]);
    await answerCallbackQuery(env, cq.id);
    await toggleSelectedId(env, userId, songId);
    await showGroupPicker(env, chatId, userId); // پیام قبلی رو ادیت می‌کنه، تیک به‌روز می‌شه
    return;
  }

  if (action === "psearch") {
    await setAwaitingField(env, userId, "search_query");
    await answerCallbackQuery(env, cq.id);
    await sendMessage(env, chatId, "کلمه‌ی جدید برای جستجوی آهنگ‌های قبلی رو بفرست:");
    return;
  }

  if (action === "pgrpdone") {
    await answerCallbackQuery(env, cq.id);
    const selectedIds = parseSelectedIds(pending.selected_ids);
    const groupId = await resolveGroupFromSelection(env, selectedIds, pending);
    await sendResultToOwner(env, chatId, pending, groupId);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// لیست چک‌باکسی: خودت مشخص می‌کنی کدوم آهنگ‌های قبلی باید با این آهنگ
// جدید هم‌گروه بشن (یعنی زیر همون دکمه‌ی شیشه‌ای قرار بگیرن). بات هیچ‌چیزی
// رو خودش حدس نمی‌زنه؛ فقط بر اساس search_query نتایج رو پیشنهاد می‌ده.
async function showGroupPicker(env, chatId, userId) {
  const pending = await getPending(env, userId);
  if (!pending) return;

  const query = (pending.search_query || pending.title || "").trim();
  const selectedIds = parseSelectedIds(pending.selected_ids);

  let results = [];
  if (query) {
    const like = `%${query}%`;
    const res = await env.DB.prepare(
      `SELECT id, title, performer
       FROM songs
       WHERE title LIKE ?1 OR performer LIKE ?1
       ORDER BY id DESC
       LIMIT 10`
    )
      .bind(like)
      .all();
    results = res.results || [];
  }

  const rows = results.map((r) => {
    const checked = selectedIds.includes(r.id);
    return [
      {
        text: `${checked ? "☑️" : "◻️"} ${r.title || "?"} - ${r.performer || "?"}`,
        callback_data: `ptoggle:${userId}:${r.id}`,
      },
    ];
  });

  rows.push([{ text: "🔎 تغییر کلمه‌ی جستجو", callback_data: `psearch:${userId}` }]);
  rows.push([
    {
      text: `✅ تایید (${selectedIds.length} انتخاب‌شده)`,
      callback_data: `pgrpdone:${userId}`,
    },
  ]);
  rows.push([{ text: "❌ انصراف", callback_data: `pcancel:${userId}` }]);

  const text =
    `جستجو برای: «${query || "—"}»\n\n` +
    (results.length === 0
      ? "چیزی پیدا نشد. اگه اسم رو عوض کنی («تغییر کلمه‌ی جستجو») شاید پیدا بشه، وگرنه بدون انتخاب هم می‌تونی «تایید» بزنی (یعنی این یه آهنگ کاملا جدیده).\n\n"
      : "روی هر آهنگی که می‌خوای با این نسخه‌ی جدید هم‌گروه بشه بزن (تیک می‌خوره). هیچی رو خودم حدس نمی‌زنم.\n\n") +
    "بعد «✅ تایید» رو بزن.";

  // اگه پیامِ چک‌باکسیِ قبلی وجود داره، همونو ادیت کن (نه پیام جدید)
  if (pending.picker_message_id) {
    const edited = await editMessage(env, chatId, pending.picker_message_id, text, {
      inline_keyboard: rows,
    });
    if (edited) return;
    // اگه ادیت نشد (مثلا پیام قدیمی پاک شده)، یه پیام جدید بفرست
  }

  const sent = await sendMessage(env, chatId, text, { inline_keyboard: rows });
  if (sent?.result?.message_id) {
    await setPickerMessageId(env, userId, sent.result.message_id);
  }
}

async function createNewGroup(env, title, performer) {
  const res = await env.DB.prepare(
    `INSERT INTO song_groups (title, performer) VALUES (?1, ?2)`
  )
    .bind(title, performer)
    .run();
  return res.meta.last_row_id;
}

// بر اساس آهنگ‌هایی که با تیک انتخاب کردی، یه group_id نهایی برمی‌گردونه:
// - هیچی انتخاب نکردی ⇒ یه گروه کاملا جدید (یعنی این آهنگ فعلا تنهاست)
// - یکی از انتخاب‌شده‌ها از قبل توی یه گروه بوده ⇒ همون گروه رو استفاده می‌کنه
//   و بقیه‌ی انتخاب‌شده‌ها (اگه گروه نداشتن) رو هم بهش اضافه می‌کنه
// - هیچ‌کدوم گروه نداشتن ⇒ یه گروه جدید می‌سازه و همه‌ی انتخاب‌شده‌ها رو عضوش می‌کنه
async function resolveGroupFromSelection(env, selectedIds, pending) {
  if (selectedIds.length === 0) {
    return await createNewGroup(env, pending.title, pending.performer);
  }

  const placeholders = selectedIds.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, group_id FROM songs WHERE id IN (${placeholders})`
  )
    .bind(...selectedIds)
    .all();

  const rows = results || [];
  const existingGroupId = rows.find((r) => r.group_id)?.group_id || null;
  const groupId = existingGroupId || (await createNewGroup(env, pending.title, pending.performer));

  // هر آهنگِ انتخاب‌شده‌ای که هنوز گروه نداشت رو به همین گروه ملحق کن
  const idsNeedingUpdate = rows.filter((r) => !r.group_id).map((r) => r.id);
  for (const id of idsNeedingUpdate) {
    await env.DB.prepare(`UPDATE songs SET group_id = ?1 WHERE id = ?2`).bind(groupId, id).run();
  }

  return groupId;
}

function parseSelectedIds(json) {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

async function toggleSelectedId(env, userId, songId) {
  const pending = await getPending(env, userId);
  const ids = parseSelectedIds(pending?.selected_ids);
  const idx = ids.indexOf(songId);
  if (idx === -1) ids.push(songId);
  else ids.splice(idx, 1);

  await env.DB.prepare(`UPDATE pending_posts SET selected_ids = ?1 WHERE admin_id = ?2`)
    .bind(JSON.stringify(ids), userId)
    .run();
}

async function setPickerMessageId(env, userId, messageId) {
  await env.DB.prepare(`UPDATE pending_posts SET picker_message_id = ?1 WHERE admin_id = ?2`)
    .bind(messageId, userId)
    .run();
}

// نتیجه‌ی نهایی: کپشن + دکمه‌ی شیشه‌ای، فقط توی همون چت خصوصیِ خودِ کاربر
// (هیچ کانال یا مقصد دیگه‌ای درکار نیست) + ثبت توی دیتابیس مشترک
async function sendResultToOwner(env, chatId, pending, groupId) {
  const botUsername = env.MAIN_BOT_USERNAME;

  if (!botUsername) {
    await sendMessage(
      env,
      chatId,
      "⚠️ متغیر MAIN_BOT_USERNAME تنظیم نشده؛ توی wrangler.toml (بخش [vars]) اضافه‌ش کن."
    );
    return;
  }

  const caption = buildCaption(pending.title, pending.performer);
  const deepLink = `https://t.me/${botUsername}?start=ver_${groupId}`;

  const body = {
    chat_id: chatId, // فقط همون چت خصوصیِ خودِ کاربر — نه کانال، نه جای دیگه
    audio: pending.file_id,
    caption,
    title: pending.title,
    performer: pending.performer,
    reply_markup: {
      inline_keyboard: [[{ text: VERSIONS_BUTTON_TEXT, url: deepLink }]],
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
      `❌ ارسال نتیجه با خطا مواجه شد:\n${data.description || "خطای نامشخص"}`
    );
    return;
  }

  const sentMessageId = data.result.message_id;

  await env.DB.prepare(
    `INSERT INTO songs (chat_id, message_id, title, performer, file_name, caption, duration, group_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(message_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       title = excluded.title,
       performer = excluded.performer,
       file_name = excluded.file_name,
       caption = excluded.caption,
       duration = excluded.duration,
       group_id = COALESCE(songs.group_id, excluded.group_id)`
  )
    .bind(
      chatId,
      sentMessageId,
      pending.title,
      pending.performer,
      pending.file_name,
      caption,
      pending.duration,
      groupId
    )
    .run();

  await deletePending(env, pending.admin_id);

  await sendMessage(env, chatId, "✅ آماده شد — فقط برای خودت فرستادم، جای دیگه‌ای پست نشد.");
}

// ── دسترسی به pending_posts ────────────────────────────────────

async function getPending(env, userId) {
  return await env.DB.prepare(`SELECT * FROM pending_posts WHERE admin_id = ?1`)
    .bind(userId)
    .first();
}

const EDITABLE_FIELDS = ["title", "performer", "search_query"];

async function updatePendingField(env, userId, field, value) {
  const col = EDITABLE_FIELDS.includes(field) ? field : "performer";
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

async function deletePending(env, userId) {
  await env.DB.prepare(`DELETE FROM pending_posts WHERE admin_id = ?1`).bind(userId).run();
}

// ── کمکی ────────────────────────────────────────────────────────

function isOwner(env, userId) {
  if (!userId) return false;
  return String(userId) === String(env.OWNER_ID || "").trim();
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

// ادیت کردن یه پیامِ قبلی (متن + دکمه‌ها) به‌جای فرستادن پیام جدید —
// برای لیست چک‌باکسیِ انتخاب آهنگ‌ها استفاده می‌شه تا با هر تیک‌زدن،
// یه پیام تازه اسپم نشه. برمی‌گردونه true اگه موفق بود.
async function editMessage(env, chatId, messageId, text, reply_markup) {
  const res = await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup }),
  });
  try {
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${env.POSTER_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}
