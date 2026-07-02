// PM2 进程守护配置示例
// 用法：`pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`
// 注意：本项目使用单个 config.json 文件存储，建议单实例运行以避免写冲突。

module.exports = {
  apps: [
    {
      name: 'freedomproxy',
      script: 'dist/server/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        // ADMIN_PASSWORD: '你的强密码',   // 推荐通过环境变量注入而非写入文件
        // SESSION_SECRET: '一段随机长字符串',
        TRUST_PROXY: 'true',
      },
    },
  ],
};
