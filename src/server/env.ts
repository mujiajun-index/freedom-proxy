import fs from 'fs';

/**
 * 极简 .env 加载器（零依赖）。
 * 解析 KEY=VALUE 行并写入 process.env；已存在的真实环境变量优先，不被文件覆盖。
 *
 * 支持的特性：
 *  - 忽略空行与 # 注释
 *  - 容忍行首 `export ` 前缀（shell 风格）
 *  - 去除值两侧的成对引号（单引号 / 双引号）
 */
export function loadDotenv(filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // 无 .env 文件，静默跳过
  }

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 去除可选的 `export ` 前缀
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    let key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去除行内注释（仅当引号包裹时不处理，避免误伤值内的 #）
    if (
      !(value.startsWith('"') || value.startsWith("'")) &&
      value.includes(' #')
    ) {
      value = value.split(' #')[0].trim();
    }
    if (!key) continue;

    // 去除两侧成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 真实环境变量优先，不覆盖
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
