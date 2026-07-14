import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execSync } from "child_process";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import sharp from "sharp";

const PORT = process.env.PORT || 3000;

// ── DuckDuckGo 搜索小红书（无需 cookie）──────────────────────────────────────
async function searchXhsViaDDG(keyword, limit = 10) {
  const query = encodeURIComponent(`site:xiaohongshu.com ${keyword}`);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Step 1: 拿 vqd token
  let vqd = "";
  try {
    const initHtml = execSync(
      `curl -sL -A "${UA}" -H "Accept-Language: zh-CN,zh;q=0.9" --max-time 10 "https://duckduckgo.com/?q=${query}&ia=web"`,
      { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );
    const vqdMatch = initHtml.match(/vqd=['"]([^'"]+)['"]/);
    if (vqdMatch) vqd = vqdMatch[1];
  } catch (e) {
    console.error("DDG init failed:", e.message);
  }

  if (!vqd) {
    return await searchXhsViaHtml(keyword, limit);
  }

  // Step 2: 调用 DDG JS API
  let results = [];
  try {
    const apiUrl = `https://links.duckduckgo.com/d.js?q=${query}&vqd=${encodeURIComponent(vqd)}&p=1&s=0&df=&ex=-1`;
    const apiRes = execSync(
      `curl -sL -A "${UA}" -H "Referer: https://duckduckgo.com/" --max-time 10 "${apiUrl}"`,
      { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );
    const dataMatch = apiRes.match(/DDG\.pageLayout\.load\('d',(\[.+\])\)/s);
    if (dataMatch) {
      const items = JSON.parse(dataMatch[1]);
      for (const item of items) {
        if (!item.u) continue;
        if (!item.u.includes("xiaohongshu.com") && !item.u.includes("xhslink.com")) continue;
        results.push({
          title: item.t ? item.t.replace(/<[^>]+>/g, "") : "(无标题)",
          url: item.u,
          snippet: item.a ? item.a.replace(/<[^>]+>/g, "") : "",
        });
        if (results.length >= limit) break;
      }
    }
  } catch (e) {
    console.error("DDG API failed:", e.message);
  }

  if (results.length === 0) {
    return await searchXhsViaHtml(keyword, limit);
  }
  return results;
}

// ── 备用：抓 DuckDuckGo HTML 页面解析 ────────────────────────────────────────
async function searchXhsViaHtml(keyword, limit = 10) {
  const query = encodeURIComponent(`site:xiaohongshu.com ${keyword}`);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const results = [];

  try {
    const html = execSync(
      `curl -sL -A "${UA}" -H "Accept-Language: zh-CN,zh;q=0.9" --max-time 15 "https://html.duckduckgo.com/html/?q=${query}"`,
      { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );

    // 提取链接和标题
    const linkRe = /class="result__a"[^>]*href="([^"]*xiaohongshu\.com[^"]*)"[^>]*>([^<]+)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([^<]+)</g;
    const snippets = [];
    let sm;
    while ((sm = snippetRe.exec(html)) !== null) {
      snippets.push(sm[1].trim());
    }
    let lm;
    let idx = 0;
    while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
      results.push({
        title: lm[2].trim(),
        url: lm[1],
        snippet: snippets[idx] || "",
      });
      idx++;
    }
  } catch (e) {
    console.error("DDG HTML fallback failed:", e.message);
  }

  return results;
}

// ── sharp 图片处理 ────────────────────────────────────────────────────────────
async function sharpProcess(items) {
  const results = [];
  for (const { i, path } of items) {
    try {
      const buf = await sharp(path)
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      results.push({ i, b64: buf.toString("base64") });
    } catch (e) {
      results.push({ i, b64: null });
    }
  }
  return results;
}

// ── 创建 MCP Server ───────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "xhs-search-mcp",
    version: "4.0.0",
  });

  // ── xhs_read tool ─────────────────────────────────────────────────────────
  server.tool(
    "xhs_read",
    "读取小红书笔记内容。输入一个小红书链接（短链 xhslink.com 或完整链接 xiaohongshu.com），返回笔记标题、正文、作者、互动数据、首屏评论和图片。视频帖只返回文字和封面图。Keywords: 小红书 xiaohongshu xhs read note link",
    {
      url: z.string().describe("小红书链接（短链或完整链接）"),
      include_images: z.boolean().optional().describe("是否返回图片，默认 true。传 false 只返回文字，省 token"),
    },
    async ({ url, include_images = true }) => {
      const XHS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
      const TMP_DIR = "/tmp/xhs_images";

      let html;
      try {
        const safeUrl = url.replace(/"/g, "");
        const curlCmd = `curl -sL -A "${XHS_UA}" --max-time 15 "${safeUrl}"`;
        html = execSync(curlCmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      } catch (e) {
        return { content: [{ type: "text", text: `请求失败: ${e.message}` }] };
      }

      const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
      if (!stateMatch) {
        return { content: [{ type: "text", text: "无法解析页面：未找到 __INITIAL_STATE__。可能链接无效或小红书页面结构变化。" }] };
      }

      let state;
      try {
        const stateStr = stateMatch[1].replace(/undefined/g, "null");
        state = JSON.parse(stateStr);
      } catch (e) {
        return { content: [{ type: "text", text: `JSON 解析失败: ${e.message}` }] };
      }

      let note = state?.noteData?.data?.noteData;
      if (!note && state?.note?.noteDetailMap) {
        const map = state.note.noteDetailMap;
        const firstKey = Object.keys(map)[0];
        note = firstKey ? map[firstKey]?.note : null;
      }

      if (!note) {
        return { content: [{ type: "text", text: "未找到笔记数据。可能笔记已删除或链接无效。" }] };
      }

      const title = note.title || "(无标题)";
      const desc = note.desc || "";
      const noteType = note.type || "unknown";
      const user = note.user?.nickName || note.user?.nickname || "未知用户";
      const time = note.time ? new Date(note.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "";
      const likes = note.interactInfo?.likedCount || "0";
      const collects = note.interactInfo?.collectedCount || "0";
      const comments = note.interactInfo?.commentCount || "0";
      const imageList = note.imageList || [];

      let commentData = state?.noteData?.data?.commentData;
      if (!commentData && state?.note?.noteDetailMap) {
        const map = state.note.noteDetailMap;
        const firstKey = Object.keys(map)[0];
        commentData = firstKey ? map[firstKey]?.comments : null;
      }

      let commentText = "";
      if (commentData?.comments && commentData.comments.length > 0) {
        commentText = "\n\n---\n评论：\n";
        for (const c of commentData.comments.slice(0, 20)) {
          const cUser = c.user?.nickName || c.user?.nickname || c.userInfo?.nickname || "匿名";
          const cContent = c.content || "";
          const cLikes = c.likeCount || 0;
          commentText += `• ${cUser}: ${cContent}`;
          if (cLikes > 0) commentText += ` (${cLikes}赞)`;
          commentText += "\n";
          if (c.subComments && c.subComments.length > 0) {
            for (const sc of c.subComments.slice(0, 3)) {
              const scUser = sc.user?.nickName || sc.user?.nickname || sc.userInfo?.nickname || "匿名";
              commentText += `  ↳ ${scUser}: ${sc.content || ""}\n`;
            }
          }
        }
      }

      let text = `������ ${title}\n`;
      text += `������ ${user}`;
      if (time) text += ` · ${time}`;
      text += `\n❤️ ${likes}  ⭐ ${collects}  ������ ${comments}`;
      if (noteType === "video") text += `  ������ 视频帖`;
      text += `\n\n${desc}`;
      text += commentText;

      const contentBlocks = [{ type: "text", text }];

      if (include_images && imageList.length > 0) {
        const dlPaths = [];
        try {
          mkdirSync(TMP_DIR, { recursive: true });
          const items = [];
          for (let i = 0; i < Math.min(imageList.length, 9); i++) {
            const img = imageList[i];
            let imgUrl = img.url || img.urlDefault || "";
            if (!imgUrl) continue;
            if (imgUrl.startsWith("//")) imgUrl = "https:" + imgUrl;
            if (!imgUrl.startsWith("http")) continue;
            try {
              const imgPath = join(TMP_DIR, `xhs_${Date.now()}_${i}.jpg`);
              execSync(`curl -sL -A "${XHS_UA}" --max-time 10 -o "${imgPath}" "${imgUrl}"`, { encoding: "utf-8" });
              items.push({ i, path: imgPath });
              dlPaths.push(imgPath);
            } catch {}
          }
          if (items.length) {
            const results = await sharpProcess(items);
            for (const r of results) {
              if (r.b64) contentBlocks.push({ type: "image", data: r.b64, mimeType: "image/jpeg" });
            }
          }
        } catch (sharpErr) {
          contentBlocks.push({ type: "text", text: `\n(图片处理失败: ${sharpErr.message})` });
        }
        for (const p of dlPaths) { try { unlinkSync(p); } catch {} }
      } else if (imageList.length > 0) {
        contentBlocks[0].text += `\n\n(共 ${imageList.length} 张图片，传 include_images=true 查看)`;
      }

      return { content: contentBlocks };
    }
  );

  // ── xhs_search tool v4.0（DuckDuckGo，无需 cookie）────────────────────────
  server.tool(
    "xhs_search",
    "搜索小红书笔记。输入关键词，通过 DuckDuckGo 搜索返回相关笔记链接和摘要，无需登录和 cookie。Keywords: 小红书 搜索 search xhs",
    {
      keyword: z.string().describe("搜索关键词"),
      limit: z.number().int().optional().describe("返回结果数量，默认10，最大20"),
    },
    async ({ keyword, limit = 10 }) => {
      const results = await searchXhsViaDDG(keyword, Math.min(limit, 20));

      if (results.length === 0) {
        return { content: [{ type: "text", text: `搜索"${keyword}"未找到结果。DuckDuckGo 可能暂时限速，稍后重试。` }] };
      }

      let text = `������ 搜索"${keyword}" — 找到 ${results.length} 条结果：\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        text += `${i + 1}. ${r.title}\n`;
        if (r.snippet) text += `   ${r.snippet}\n`;
        text += `   ������ ${r.url}\n\n`;
      }
      text += `---\n������ 用 xhs_read 工具传入链接可查看完整笔记内容和图片。`;

      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "4.0.0",
      mode: "DuckDuckGo (no cookie required)",
    }));
    return;
  }

  if (req.url === "/mcp" || req.url?.startsWith("/mcp")) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    const body = await readBody(req);
    let parsedBody;
    try {
      parsedBody = body.length > 0 ? JSON.parse(body.toString()) : undefined;
    } catch {
      parsedBody = undefined;
    }
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

httpServer.listen(PORT, () => {
  console.log(`xhs-search-mcp v4.0 running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Mode: DuckDuckGo search (no cookie required)`);
});
