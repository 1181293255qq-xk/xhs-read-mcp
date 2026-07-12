import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execSync } from "child_process";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import sharp from "sharp";

const PORT = process.env.PORT || 3000;

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
    name: "xhs-read-mcp",
    version: "1.0.0",
  });

  // ── xhs_read tool ────────────────────────────────────────────────────────────
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

      // 1. curl 请求页面
      let html;
      try {
        const safeUrl = url.replace(/"/g, "");
        const curlCmd = `curl -sL -A "${XHS_UA}" --max-time 15 "${safeUrl}"`;
        html = execSync(curlCmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      } catch (e) {
        return { content: [{ type: "text", text: `请求失败: ${e.message}` }] };
      }

      // 2. 提取 __INITIAL_STATE__
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

      // 3. 提取笔记数据（兼容两种路径）
      let note = state?.noteData?.data?.noteData;
      if (!note && state?.note?.noteDetailMap) {
        const map = state.note.noteDetailMap;
        const firstKey = Object.keys(map)[0];
        note = firstKey ? map[firstKey]?.note : null;
      }

      if (!note) {
        return { content: [{ type: "text", text: "未找到笔记数据。可能笔记已删除或链接无效。" }] };
      }

      // 4. 提取基本信息
      const title = note.title || "(无标题)";
      const desc = note.desc || "";
      const noteType = note.type || "unknown";
      const user = note.user?.nickName || note.user?.nickname || "未知用户";
      const time = note.time ? new Date(note.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "";
      const likes = note.interactInfo?.likedCount || "0";
      const collects = note.interactInfo?.collectedCount || "0";
      const comments = note.interactInfo?.commentCount || "0";
      const imageList = note.imageList || [];

      // 5. 提取评论
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

      // 6. 格式化文本
      let text = `������ ${title}\n`;
      text += `������ ${user}`;
      if (time) text += ` · ${time}`;
      text += `\n❤️ ${likes}  ⭐ ${collects}  ������ ${comments}`;
      if (noteType === "video") text += `  ������ 视频帖`;
      text += `\n\n${desc}`;
      text += commentText;

      const contentBlocks = [{ type: "text", text }];

      // 7. 图片处理
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

  return server;
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  // 健康检查
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
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
  console.log(`xhs-read-mcp server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
