/**
 * 开发用静态服务器。零依赖，仅用于本地预览与冒烟测试。
 * 用法：node tools/serve.mjs [port] [root]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticServer(rootDir = process.cwd()) {
  const root = resolve(rootDir);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = resolve(root, `.${pathname}`);
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }

      const info = await stat(filePath).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: ${pathname}`);
        return;
      }

      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      console.error(error);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 Server Error');
    }
  });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.argv[2] || process.env.PORT || 5173);
  const root = resolve(process.argv[3] || process.cwd());
  // 第四个参数传 0.0.0.0 即可让同一 Wi-Fi 下的手机访问
  const host = process.argv[4] || process.env.HOST || '127.0.0.1';

  createStaticServer(root).listen(port, host, () => {
    console.log(`哈哈阅读 dev server: http://127.0.0.1:${port}`);

    if (host === '0.0.0.0' || host === '::') {
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            console.log(`  局域网（${name}）: http://${address.address}:${port}`);
          }
        }
      }
      console.log('  提示：局域网 http 下没有 Service Worker，不能安装/离线；需要安装请用 HTTPS 部署。');
    }
  });
}
