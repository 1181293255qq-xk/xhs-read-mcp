import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import vm from "vm";
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

// ── 签名生成（使用 vm 模块）──────────────────────────────────────────────────
let _signContext = null;

function getSignContext() {
  if (_signContext) return _signContext;
  
  if (!existsSync("./signature.js")) {
    try {
      execSync(`curl -sL https://raw.githubusercontent.com/leeguooooo/xhs-python-sdk/main/xhs_sdk/core/signature.js -o signature.js`, { encoding: "utf-8", timeout: 30000 });
    } catch (e) {
      console.error("Failed to download signature.js:", e.message);
      return null;
    }
  }

  try {
    const signJs = readFileSync("./signature.js", "utf-8");
    
    const context = {
      console: { log: () => {}, error: () => {}, warn: () => {} },
      Buffer: Buffer,
      process: { platform: "linux" },
      setTimeout: setTimeout,
      setInterval: () => {},
      clearTimeout: clearTimeout,
      clearInterval: () => {},
      String: String,
      Array: Array,
      Object: Object,
      Number: Number,
      Boolean: Boolean,
      Math: Math,
      Date: Date,
      JSON: JSON,
      Error: Error,
      TypeError: TypeError,
      parseInt: parseInt,
      parseFloat: parseFloat,
      isNaN: isNaN,
      encodeURIComponent: encodeURIComponent,
      decodeURIComponent: decodeURIComponent,
      RegExp: RegExp,
      undefined: undefined,
      NaN: NaN,
      Infinity: Infinity,
      isNaN: isNaN,
      isFinite: isFinite,
    };
    
    // signature.js 需要 window = global
    context.window = context;
    context.global = context;
    context.document = { cookie: "" };
    context.navigator = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
    
    vm.createContext(context);
    vm.runInContext(signJs, context);
    
    _signContext = context;
    console.log("Signature context loaded successfully");
    return context;
  } catch (e) {
    console.error("Failed to load signature context:", e.message);
    return null;
  }
}

function generateSignature(uri, data, cookie) {
  try {
    const ctx = getSignContext();
    if (!ctx) return null;
    
    // 设置 cookie
    ctx.document.cookie = cookie;
    
    // 调用签名函数
    const result = ctx.GetXsXt(uri, data, cookie);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    
    return {
      "x-s": parsed["X-s"] || parsed["x-s"] || "",
      "x-t": String(parsed["X-t"] || parsed["x-t"] || ""),
    };
  } catch (e) {
    console.error(`Signature generation failed: ${e.message}`);
    return null;
  }
}

// ── 生成 search_id ────────────────────────────────────────────────────────────
function generateSearchId() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 2147483646);
  const num = BigInt(timestamp) * BigInt(2 ** 64) + BigInt(random);
  return num.toString(36).toUpperCase() || "0";
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
    version: "3.1.0",
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

  // ── xhs_search tool（v3.1）──────────────────────────────────────────────────
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

      const sortMap = { general: "general", popularity: "popularity_desc", time: "time_desc" };
      const sortValue = sortMap[sort] || "general";
      const searchId = generateSearchId();

      const searchData = {
        keyword: keyword,
        page: 1,
        page_size: Math.min(limit, 50),
        search_id: searchId,
        sort: sortValue,
        note_type: 0,
        ext_flags: [],
        geo: "",
        image_formats: JSON.stringify(["jpg", "webp", "avif"]),
      };

      const uri = "/api/sns/web/v1/search/notes";

      // 生成签名
      const signature = generateSignature(uri, searchData, cookie);
      if (!signature || !signature["x-s"]) {
        // 签名失败，返回详细错误
        let errMsg = "❌ 签名生成失败。";
        // 检查 signature.js 是否存在
        if (!existsSync("./signature.js")) {
          errMsg += " signature.js 文件不存在。";
        } else {
          const stat = readFileSync("./signature.js", "utf-8");
          errMsg += ` signature.js 大小: ${stat.length} 字符。`;
          errMsg += ` 包含GetXsXt: ${stat.includes("GetXsXt")}。`;
        }
        return { content: [{ type: "text", text: errMsg }] };
      }

      // 写入请求体
      const bodyFile = "/tmp/xhs_search_body.json";
      writeFileSync(bodyFile, JSON.stringify(searchData));

      // 构造 curl 命令
      const apiUrl = `https://edith.xiaohongshu.com${uri}`;
      const curlCmd = `curl -sL -X POST "${apiUrl}" \
        -A "${XHS_UA}" \
        -b "${cookie}" \
        -H "Content-Type: application/json;charset=UTF-8" \
        -H "Origin: https://www.xiaohongshu.com" \
        -H "Referer: https://www.xiaohongshu.com/" \
        -H "Accept: application/json" \
        -H "x-s: ${signature["x-s"]}" \
        -H "x-t: ${signature["x-t"]}" \
        -d @${bodyFile} \
        --max-time 15`;

      let apiResult;
      try {
        apiResult = execSync(curlCmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      } catch (e) {
        return { content: [{ type: "text", text: `搜索请求失败: ${e.message}` }] };
      }

      // 解析API返回
      let apiData;
      try {
        apiData = JSON.parse(apiResult);
      } catch (e) {
        return { content: [{ type: "text", text: `API返回解析失败。\n返回内容前500字符: ${apiResult.substring(0, 500)}` }] };
      }

      // 检查API错误
      if (apiData.code && apiData.code !== 0) {
        return { content: [{ type: "text", text: `❌ API返回错误: code=${apiData.code}, msg=${apiData.msg || ""}\n\n这可能意味着签名验证失败或cookie过期。` }] };
      }

      // 提取搜索结果
      const items = apiData?.data?.items || [];
      if (items.length === 0) {
        return { content: [{ type: "text", text: `搜索"${keyword}"未找到结果。` }] };
      }

      // 格式化结果
      let resultText = `������ 搜索"${keyword}" - 找到${items.length}条结果：\n\n`;
      const maxResults = Math.min(items.length, limit, 50);

      for (let i = 0; i < maxResults; i++) {
        const item = items[i];
        const note = item.note_card || item.note || item;
        const noteId = note.note_id || note.noteId || item.id || "";
        const title = note.display_title || note.title || "(无标题)";
        const user = note.user?.nickname || note.user?.nickName || "未知用户";
        const likes = note.interact_info?.liked_count || "0";
        const noteType = note.type || "";
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
  );

  return server;
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      status: "ok", 
      version: "3.1.0",
      signatureLoaded: _signContext !== null,
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
  console.log(`xhs-search-mcp server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Cookie configured: ${getXhsCookie() ? "YES" : "NO"}`);
  // 预加载签名上下文
  getSignContext();
});