import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE && process.env.DATA_FILE.length > 0 ? process.env.DATA_FILE : null;

if (!process.env.ADMIN_TOKEN) {
  console.warn('[warn] 未设置 ADMIN_TOKEN，当前使用默认开发令牌，请勿用于生产环境');
}

const { handler } = createApp({
  dataFile,
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
});

const server = createServer(handler);

server.listen(port, () => {
  console.log(`会员系统已启动：http://127.0.0.1:${port}  数据文件：${dataFile ?? '（内存模式）'}`);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭服务…`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
