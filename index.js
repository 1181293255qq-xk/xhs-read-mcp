import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execSync } from "child_process";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import sharp from "sharp";

const PORT = process.env.PORT || 3000;

// ── cookie 构造 ───────────────────────────────────────────────────────────────
function getXhsCookie() {
  const webSession = process.env.XHS_WEB_SESSION || "";
  const a1 = process.env.XHS_A1 || "";
  const webId = process.env.XHS_WEB_ID || "";
  if (!webSession) return null;
  return `web_session=${webSession}; a1=${a1}; webId=${webId}`;
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

// ── 递归搜索 state 中的笔记数据 ────────────────────────────────────────────────
function findNotesInState(obj, depth = 0, path = "") {
  if (depth > 5 || !obj || typeof obj !== "object") return [];
  
  // 检查当前对象是否看起来像笔记数组
  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === "object") {
      // 检查是否有笔记特征字段
      const hasNoteFields = first.noteId || first.id || first.note_id || 
                           first.displayTitle || first.title || first.display_title ||
                           first.noteCard;
      if (hasNoteFields) {
        return obj;
      }
    }
  }
  
  // 递归搜索
  let results = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const found = findNotesInState(val, depth + 1, `${path}.${key}`);
      if (found.length > 0) return found;
    }
  }
  return results;
}

// ── 提取 state 的键结构（调试用）──────────────────────────────────────────────
function getStateKeys(obj, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth || !obj || typeof obj !== "object") return "";
  let result = "";
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const type = Array.isArray(val) ? `Array(${val.length})` : typeof val;
    result += `${"  ".repeat(depth)}${key}: ${type}\n`;
    if (val && typeof val === "object" && depth < maxDepth - 1) {
      result += getStateKeys(val, depth + 1, maxDepth);
    }
  }
  return result;
}

// ── 创建 MCP Server ───────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "xhs-search-mcp",
    version: "2.1.0",
  });

  // ── xhs_read tool（保留原有功能）────────────────────────────────────────────
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

  // ── xhs_search tool（v2.1 增强搜索）─────────────────────────────────────────
  server.tool(
    "xhs_search",
    "搜索小红书笔记。输入关键词，返回相关笔记列表（标题、作者、点赞数、链接）。需配置cookie环境变量。Keywords: 小红书 搜索 search xhs",
    {
      keyword: z.string().describe("搜索关键词"),
      limit: z.number().int().optional().describe("返回结果数量，默认20，最大50"),
      sort: z.string().optional().describe("排序：general(综合) / popularity(最热) / time(最新)，默认general"),
    },
    async ({ keyword, limit = 20, sort = "general" }) => {
      const cookie = getXhsCookie();
      if (!cookie) {
        return { content: [{ type: "text", text: "❌ 未配置小红书cookie。请在Render环境变量中设置：\nXHS_WEB_SESSION\nXHS_A1\nXHS_WEB_ID" }] };
      }

      const XHS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      
      const sortMap = { 
        general: "general", 
        popularity: "popularity_desc", 
        time: "time_desc" 
      };
      const sortValue = sortMap[sort] || "general";
      
      // 尝试多种URL格式
      const urls = [
        `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes&type=51&sort=${sortValue}`,
        `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
        `https://www.xiaohongshu.com/web_api/sns/v1/search/notes?keyword=${encodeURIComponent(keyword)}&page=1&page_size=20&sort=${sortValue}`,
      ];

      let html = "";
      let lastError = "";
      let usedUrl = "";

      for (const searchUrl of urls) {
        try {
          const curlCmd = `curl -sL -A "${XHS_UA}" -b "${cookie}" -H "Referer: https://www.xiaohongshu.com/" --max-time 15 "${searchUrl}"`;
          html = execSync(curlCmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
          usedUrl = searchUrl;
          
          // 如果是API URL，直接尝试解析JSON
          if (searchUrl.includes("/web_api/")) {
            try {
              const apiData = JSON.parse(html);
              if (apiData?.data?.items || apiData?.data?.notes) {
                const items = apiData.data.items || apiData.data.notes;
                const notes = items.map(item => {
                  const note = item.note || item.note_card || item;
                  return {
                    noteId: note.note_id || note.noteId || note.id || "",
                    displayTitle: note.display_title || note.title || note.displayTitle || "",
                    user: note.user?.nickname || note.user?.nickName || "",
                    likes: note.interact_info?.liked_count || note.likedCount || "0",
                    link: note.note_id ? `https://www.xiaohongshu.com/explore/${note.note_id}` : "",
                  };
                }).filter(n => n.noteId || n.displayTitle);
                
                if (notes.length > 0) {
                  let resultText = `������ 搜索"${keyword}" - 找到${notes.length}条结果：\n\n`;
                  for (let i = 0; i < Math.min(notes.length, limit); i++) {
                    const n = notes[i];
                    resultText += `${i + 1}. ${n.displayTitle || "(无标题)"}\n`;
                    resultText += `   ������ ${n.user}  ❤️ ${n.likes}\n`;
                    if (n.link) resultText += `   ������ ${n.link}\n`;
                    resultText += `\n`;
                  }
                  resultText += `---\n������ 用 xhs_read 工具传入链接可查看完整笔记内容和图片。`;
                  return { content: [{ type: "text", text: resultText }] };
                }
              }
            } catch (jsonErr) {
              lastError = `API JSON解析失败: ${jsonErr.message}`;
              continue;
            }
          }
          
          // HTML页面：提取 __INITIAL_STATE__
          const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
          if (stateMatch) {
            try {
              const stateStr = stateMatch[1].replace(/undefined/g, "null");
              const state = JSON.parse(stateStr);
              
              // 方法1: 已知路径
              let notes = state?.search?.notes || state?.search?.feeds || state?.search?.result?.notes || [];
              
              // 方法2: 递归搜索
              if (!notes || notes.length === 0) {
                notes = findNotesInState(state);
              }
              
              if (notes && notes.length > 0) {
                const maxResults = Math.min(notes.length, limit, 50);
                let resultText = `������ 搜索"${keyword}" - 找到${notes.length}条结果（显示前${maxResults}条）：\n\n`;
                
                for (let i = 0; i < maxResults; i++) {
                  const note = notes[i];
                  const noteId = note.noteId || note.id || note.note_id || note.noteCard?.noteId || "";
                  const title = note.displayTitle || note.title || note.display_title || note.noteCard?.displayTitle || "(无标题)";
                  const user = note.user?.nickName || note.user?.nickname || note.userInfo?.nickname || note.noteCard?.user?.nickName || "未知用户";
                  const likes = note.interactInfo?.likedCount || note.likedCount || note.likeCount || note.noteCard?.interactInfo?.likedCount || "0";
                  const noteType = note.type || note.noteType || note.noteCard?.type || "";
                  const link = noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : "";
                  
                  resultText += `${i + 1}. ${title}\n`;
                  resultText += `   ������ ${user}  ❤️ ${likes}`;
                  if (noteType === "video") resultText += `  ������ 视频`;
                  if (link) resultText += `\n   ������ ${link}`;
                  resultText += `\n\n`;
                }
                
                resultText += `---\n������ 用 xhs_read 工具传入链接可查看完整笔记内容和图片。`;
                return { content: [{ type: "text", text: resultText }] };
              }
              
              // 如果找到了state但没有notes，返回调试信息
              const keysInfo = getStateKeys(state, 0, 3);
              lastError = `找到__INITIAL_STATE__但未找到笔记数据。\nState结构：\n${keysInfo}\n使用的URL: ${usedUrl}`;
              continue;
            } catch (e) {
              lastError = `JSON解析失败: ${e.message}`;
              continue;
            }
          }
          
          // 检查是否被重定向到登录页
          if (html.includes("login") || html.includes("登录")) {
            lastError = "Cookie已过期，被重定向到登录页。";
            continue;
          }
          
          lastError = `无法解析搜索页面。URL: ${usedUrl}, HTML长度: ${html.length}`;
          continue;
        } catch (e) {
          lastError = `请求失败: ${e.message}`;
          continue;
        }
      }

      // 所有URL都失败了，返回调试信息
      let debugText = `❌ 搜索"${keyword}"失败。\n错误: ${lastError}\n\n`;
      if (html && html.length > 0) {
        debugText += `HTML片段(前500字符):\n${html.substring(0, 500)}\n`;
      }
      return { content: [{ type: "text", text: debugText }] };
    }
  );

  return server;
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "2.1.0" }));
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
  console.log(`xhs-search-mcp server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Cookie configured: ${getXhsCookie() ? "YES" : "NO"}`);
});