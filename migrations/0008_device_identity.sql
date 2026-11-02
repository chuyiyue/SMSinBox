-- UI/UX v2：设备身份与平台。
-- 只追加列，不改已有行、不删数据：
--   platform       设备平台（ios / android / other），旧设备统一归为 other
--   token_version  凭据版本，系统 JWT 里的 ver 必须与它一致；改大即吊销旧 token
-- 旧设备仍保留原来的随机 Bearer token（token_hash 不变）和可选 HMAC secret，
-- 迁移窗口内两条认证路径并存，因此这里不能重写 token_hash。

ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT 'other';
ALTER TABLE devices ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
