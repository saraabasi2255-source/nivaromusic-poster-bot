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
  -- 'audio' (آهنگِ معمولی با کپشن+دکمه‌ی جستجو) یا 'voice' (ویس با
  -- دکمه‌ی «دانلود آهنگ» که به یه لینکِ دلخواه وصله)
  kind TEXT DEFAULT 'audio',
  -- فقط برای kind='voice': لینکی که قراره زیر دکمه‌ی «دانلود آهنگ» بره
  link TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- اگه pending_posts رو قبلا (بدون ستون‌های kind / link) ساخته بودی، این
-- دو خط رو یک‌بار جدا اجرا کن (هرکدوم از قبل بود، خطا می‌ده، بی‌خیالش شو):
-- ALTER TABLE pending_posts ADD COLUMN kind TEXT DEFAULT 'audio';
-- ALTER TABLE pending_posts ADD COLUMN link TEXT;

-- هر ردیف یعنی «وقتی روی این دکمه زدن، این کلمه رو براش سرچ کن».
-- به‌جای گذاشتن مستقیمِ اسم آهنگ (که فارسیه و توی لینک تلگرام جا نمی‌شه)
-- توی دکمه، فقط شماره‌ی همین ردیف رو می‌ذاریم (؟start=q_<id>).
CREATE TABLE IF NOT EXISTS search_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  performer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- اگه search_links رو قبلا (بدون ستون performer) ساخته بودی، این خط رو
-- یک‌بار جدا اجرا کن (اگه از قبل بود، خطا می‌ده، بی‌خیالش شو):
-- ALTER TABLE search_links ADD COLUMN performer TEXT;

-- اگه pending_posts رو قبلا با نسخه‌ی قدیمی‌تر این پروژه ساخته بودی و
-- ستون‌های زیر رو نداره، این خطا رو نادیده بگیر (یعنی از قبل درست بوده).
-- (این پروژه دیگه از این ستون‌ها استفاده نمی‌کنه، وجودشون هم مشکلی ایجاد نمی‌کنه)
