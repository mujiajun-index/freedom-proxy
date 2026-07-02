// 打开 Deno KV（全局只需打开一次）
const kv = await Deno.openKv();
// 使用一个固定的 key 来存储目标 URL
const TARGET_KEY = ["targetUrl"];

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 如果请求带有 setUrl 参数，则更新目标 URL
  if (url.searchParams.has("setUrl")) {
    const newTargetUrl = url.searchParams.get("setUrl")!;
    // 基本校验一下 URL 格式
    try {
      new URL(newTargetUrl);
    } catch {
      return new Response("无效的 URL，请检查格式。", { status: 400 });
    }
    await kv.set(TARGET_KEY, newTargetUrl);
    return new Response(`代理目标 URL 已更新为：${newTargetUrl}`);
  }

  // 仅处理路径以 /proxy 开头的请求
  if (url.pathname.startsWith("/proxy")) {
    // 从 KV 中获取目标 URL
    const result = await kv.get(TARGET_KEY);
    if (!result.value) {
      return new Response(
          "未设置代理目标 URL，请使用 ?setUrl=你的目标URL 进行设置。",
          { status: 400 }
      );
    }
    const baseUrl = result.value as string;

    // 去掉 /proxy 前缀，剩余部分作为相对路径
    const proxyPath = url.pathname.slice("/proxy".length);
    // 构造最终的请求 URL：以存储的 baseUrl 为基准，加上剩余路径和原有查询参数（注意：此处不包括 setUrl 参数，因为已单独处理）
    let finalUrl: string;
    try {
      finalUrl = new URL(proxyPath + url.search, baseUrl).toString();
    } catch {
      return new Response("构造目标 URL 出错。", { status: 500 });
    }

    // 构造一个新的请求，将客户端的 method、headers 和 body 传递过去
    // 注意：req.body 是一个 ReadableStream，可以直接传递
    const proxyRequest = new Request(finalUrl, {
      method: req.method,
      headers: req.headers, // headers 会自动处理 Host 等，但通常建议不要传递所有，特别是与代理自身相关的
      body: req.body, // 直接传递请求体流
      // 传递 Deno.serve 的信号，以便客户端断开连接时代理请求也能被取消
      signal: req.signal,
    });

    try {
      const targetResponse = await fetch(proxyRequest);

      // --- 关键修改点：直接返回 targetResponse.body ---
      // 复制目标响应的 headers
      // 注意：Content-Encoding 如果目标返回了，Deno 会自动处理解压，但通常代理希望直接转发。
      // 可以选择性地移除一些不适合直接转发的头，例如 Content-Length 如果原始响应是 chunked。
      const responseHeaders = new Headers();
      for (const [key, value] of targetResponse.headers.entries()) {
        // 通常不需要修改 Content-Length，因为如果 body 是流，Deno 会自动使用 Transfer-Encoding: chunked
        // 如果原始是 Content-Length，Deno 也会尝试保持。
        responseHeaders.set(key, value);
      }
      // 移除 Content-Encoding 或调整它，如果代理本身做了修改。
      // 例如，如果原始响应是 gzip 压缩的，但代理想直接转发未解压的流，可能需要注意。
      // 在Deno的fetch中，通常会自动处理Content-Encoding的解压，所以如果想保持原始压缩，需要特殊处理。
      // 但对于直接转发body流的场景，Deno通常会保持原始行为。
      // 如果目标返回了 Transfer-Encoding: chunked，Deno也会自动转发。

      return new Response(targetResponse.body, { // 直接返回 body 流
        status: targetResponse.status,
        statusText: targetResponse.statusText, // 包含 statusText 提高兼容性
        headers: responseHeaders,
      });
    } catch (err) {
      // 捕获 fetch 过程中可能发生的网络错误
      console.error("Error during proxy fetch:", err);
      return new Response(`请求目标 URL 时发生错误：${err.message || err}`, {
        status: 500,
      });
    }
  }

  // 其他请求返回提示信息
  return new Response(
      "欢迎使用 Deno Proxy：\n" +
      "1. 使用 /proxy 开头的路径发起代理请求。\n" +
      "2. 使用 ?setUrl=你的目标URL 设置代理目标。"
  );
});
