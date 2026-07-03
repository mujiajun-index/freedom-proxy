// 构建后把 public/ 拷贝到 dist/public/，使部署产物（dist.zip）自包含，
// 不再依赖外部 public 目录即可访问管理后台。
// 用法：在 package.json 的 build 脚本里 `tsc && node scripts/copy-assets.cjs`
// 要求 Node >= 16.7（fs.cpSync）；本项目 engines 声明 >=18。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'public');
const dest = path.join(root, 'dist', 'public');

if (!fs.existsSync(src)) {
  console.warn('[copy-assets] 源目录 public/ 不存在，跳过拷贝');
  process.exit(0);
}

// 清理旧产物，避免残留已删除的文件
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-assets] 已复制 public/ -> dist/public/ (${dest})`);
