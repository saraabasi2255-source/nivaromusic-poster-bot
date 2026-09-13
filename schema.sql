-- این پروژه از همون D1 دیتابیسِ بات اصلی استفاده می‌کنه، پس جدول songs
-- از قبل باید اونجا وجود داشته باشه (schema.sql پروژه‌ی اول). این فایل فقط
-- جدول‌هایی که مخصوص خودِ بات دستیاره رو می‌سازه — اجرا کردنش کاملا
-- بی‌خطره حتی اگه بعضی‌هاشون از قبل ساخته شده باشن (IF NOT EXISTS داره).
--
--   wrangler d1 execute song_search_db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS pending_posts (
  admin_id INTEGER PRIMARY KEY,
  file_id TEXT,
  file_name TEXT,
  title TEXT,
  performer TEXT,
  duration INTEGER,
  awaiting_field TEXT,
  status TEXT DEFAULT 'awaiting_confirm',
  created_at TEXT DEFAULT (datetime('now'))
);

-- هر ردیف یعنی «وقتی روی این دکمه زدن، این کلمه رو براش سرچ کن».
-- به‌جای گذاشتن مستقیمِ اسم آهنگ (که فارسیه و توی لینک تلگرام جا نمی‌شه)
-- توی دکمه، فقط شماره‌ی همین ردیف رو می‌ذاریم (؟start=q_<id>).
CREATE TABLE IF NOT EXISTS search_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- اگه pending_posts رو قبلا با نسخه‌ی قدیمی‌تر این پروژه ساخته بودی و
-- ستون‌های زیر رو نداره، این خطا رو نادیده بگیر (یعنی از قبل درست بوده).
-- (این پروژه دیگه از این ستون‌ها استفاده نمی‌کنه، وجودشون هم مشکلی ایجاد نمی‌کنه)
