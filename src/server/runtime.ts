/**
 * 运行时探测与 Deno 专属能力（KV 持久化、关停收尾钩子）。
 *
 * 设计原则：Node/Docker 下本模块全部退化为安全空操作 / false，保证既有 Node 部署零影响；
 * 仅当检测到 Deno 运行时（含 Deno Deploy）才启用 KV 持久化与 SIGINT 收尾。
 *
 * 通过 globalThis 访问 Deno 并按 any 处理，避免引入 Deno 类型库——
 * tsc 仍按 Node lib 编译，产物在 Deno 下可正常运行。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = globalThis as any;

/**
 * 是否运行在 Deno 运行时（含 Deno Deploy）且 KV 可用。
 * Node 下 globalThis.Deno 不存在 → false。
 */
export const isDeno: boolean =
  typeof g.Deno !== 'undefined' && typeof g.Deno.openKv === 'function';

/**
 * 打开 Deno KV 句柄。新版 Deno Deploy 经控制台 Databases 关联 KV 后无需连接 URL。
 * 未开通 / 不可用时抛出清晰的中文错误，便于排查。
 */
export async function getKv(): Promise<any> {
  try {
    return await g.Deno.openKv();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `打开 Deno KV 失败：${msg}\n` +
        '请到 Deno Deploy 控制台 → Databases 创建一个 KV 数据库并关联到本项目后重试。\n' +
        '（本地 deno 运行需加 --unstable-kv）'
    );
  }
}

/**
 * 注册关停收尾回调。Deno Deploy 停止实例前会先发 SIGINT，给 5 秒优雅关闭窗口，
 * 期间可完成异步刷盘；刷完后主动 exit 让进程干净退出。
 * Node 下为空操作（Docker 走文件存储，无需收尾）。
 */
export function onShutdown(fn: () => Promise<void>): void {
  if (!isDeno) return;
  try {
    g.Deno.addSignalListener('SIGINT', () => {
      // 刷盘后退出；刷盘失败也不阻塞退出（平台 5s 后会 SIGKILL 兜底）
      fn()
        .catch(() => {
          /* swallow */
        })
        .finally(() => {
          try {
            g.Deno.exit(0);
          } catch {
            /* ignore */
          }
        });
    });
  } catch {
    /* 某些环境不支持 SIGINT 监听，忽略 */
  }
}
