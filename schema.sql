-- این پروژه از همون D1 دیتابیسِ بات اصلی استفاده می‌کنه، پس جدول songs
-- از قبل باید اونجا وجود داشته باشه (schema.sql پروژه‌ی اول). این فایل فقط
-- دو تا جدولی که مخصوص خودِ بات دستیاره رو می‌سازه — اجرا کردنش کاملا
-- بی‌خطره حتی اگه از قبل با migration_versions.sql پروژه‌ی اول ساخته
-- شده باشن (IF NOT EXISTS داره).
--
--   wrangler d1 execute song_search_db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS song_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  performer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_posts (
  admin_id INTEGER PRIMARY KEY,
  file_id TEXT,
  file_name TEXT,
  title TEXT,
  performer TEXT,
  duration INTEGER,
  awaiting_field TEXT,
  status TEXT DEFAULT 'awaiting_confirm',
  -- آیدی‌های آهنگ‌های قدیمی‌ای که خودت با تیک‌زدن انتخاب کردی تا با این
  -- آهنگ جدید هم‌گروه بشن (به‌صورت آرایه‌ی JSON، مثلا "[12,15]")
  selected_ids TEXT DEFAULT '[]',
  -- کلمه‌ای که برای جستجوی آهنگ‌های قدیمی استفاده می‌شه (پیش‌فرض: همون عنوان)
  search_query TEXT,
  -- آیدی پیامِ لیستِ چک‌باکسی، تا با تیک‌زدن هر آهنگ به‌جای پیامِ جدید،
  -- همون پیام ویرایش (edit) بشه
  picker_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- اگه جدول songs از قبل هست ولی ستون group_id رو نداره (یعنی هنوز
-- migration_versions.sql رو روی پروژه‌ی اول اجرا نکردی)، این خط رو هم
-- اجرا کن (اگه از قبل وجود داشته باشه، با خطا مواجه می‌شی و اشکالی نداره):
-- ALTER TABLE songs ADD COLUMN group_id INTEGER;

-- اگه pending_posts رو قبلا (با نسخه‌ی قدیمی‌تر این پروژه) ساخته بودی و
-- ستون‌های selected_ids / search_query / picker_message_id رو نداره،
-- این سه خط رو یک‌بار جدا اجرا کن (هرکدوم که از قبل بود، خطا می‌ده، بی‌خیالش شو):
-- ALTER TABLE pending_posts ADD COLUMN selected_ids TEXT DEFAULT '[]';
-- ALTER TABLE pending_posts ADD COLUMN search_query TEXT;
-- ALTER TABLE pending_posts ADD COLUMN picker_message_id INTEGER;
