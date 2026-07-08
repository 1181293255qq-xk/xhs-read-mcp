// ── xhs_read ────────────────────────────────────────────────────────────────

server.tool(
  "xhs_read",
  `读取小红书笔记内容。输入一个小红书链接（短链 xhslink.com 或完整链接 xiaohongshu.com），返回笔记标题、正文、作者、互动数据、首屏评论和图片。
视频帖只返回文字和封面图。
Keywords: 小红书 xiaohongshu xhs read note link`,
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
      const curlCmd = `curl -sL -A "${XHS_UA}" --max-time 15 "${url.replace(/"/g, '')}"`;
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
        // 子评论
        if (c.subComments && c.subComments.length > 0) {
          for (const sc of c.subComments.slice(0, 3)) {
            const scUser = sc.user?.nickName || sc.user?.nickname || sc.userInfo?.nickname || "匿名";
            commentText += `  ↳ ${scUser}: ${sc.content || ""}\n`;
          }
        }
      }
    }

    // 6. 格式化文本
    let text = `📕 ${title}\n`;
    text += `👤 ${user}`;
    if (time) text += ` · ${time}`;
    text += `\n❤️ ${likes}  ⭐ ${collects}  💬 ${comments}`;
    if (noteType === "video") text += `  🎬 视频帖（视频内容无法显示）`;
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
        contentBlocks.push({ type: "text", text: `
(图片处理失败: ${sharpErr.message})` });
      }
      for (const p of dlPaths) { try { unlinkSync(p); } catch {} }
    } else if (imageList.length > 0) {
      contentBlocks[0].text += `\n\n(共 ${imageList.length} 张图片，传 include_images=true 查看)`;
    }

    return { content: contentBlocks };
  }
);

// -- chat_history ---------------------------------------------------------------
  server.tool(
    "chat_history",
    {
      session: z.string().optional().describe("session id 前缀 / \'last\' / \'all\'，默认 last"),
      search: z.string().optional().describe("搜索关键词"),
      context: z.number().int().optional().describe("搜索结果前后显示几轮，默认 3"),
      limit: z.number().int().optional().describe("最多返回几轮，默认 50"),
      time_range: z.string().optional().describe("时间过滤：2h / today / 2026-05-28"),
    },
    async ({ session = "last", search, context = 3, limit = 50, time_range }) => {
      try {
        const args = ["/root/extract_chat.py", session];
        if (search)     { args.push("-s");           args.push(search); }
        if (context)    { args.push("-c");            args.push(String(context)); }
        if (limit)      { args.push("-n");            args.push(String(limit)); }
        if (time_range) { args.push("--time-range");  args.push(time_range); }
        const result = spawnSync("python3", args, { timeout: 30000, encoding: "utf8" });
        const out = (result.stdout || "").trim();
        const err = (result.stderr || "").trim();
        if (result.status !== 0 && err && !out) {
          return { content: [{ type: "text", text: "chat_history error: " + err }] };
        }
        return { content: [{ type: "text", text: out || "(no results)" }] };
      } catch (err) {
        return { content: [{ type: "text", text: "chat_history error: " + err.message }] };
      }
    }
  );


