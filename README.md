# xhs-read-mcp

让 Claude 直接读小红书帖子的 MCP 工具。

发一个小红书链接，返回标题、正文、作者、互动数据、首屏评论和图片。

## 原理

小红书页面 HTML 里有一段 `__INITIAL_STATE__` 的 JSON，帖子数据都在里面。工具做三件事：

1. curl 请求链接拿 HTML
2. 提取 `__INITIAL_STATE__` 的 JSON
3. 解析返回需要的字段

不需要登录、不需要 Cookie、不需要 Puppeteer。

## 使用

这是一个 MCP server tool，集成在 MCP 服务中使用。参考 `xhs_read_snippet.js` 中的实现。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 小红书链接（短链 xhslink.com 或完整链接 xiaohongshu.com） |
| include_images | boolean | 否 | 是否返回图片，默认 true。传 false 只返回文字，省 token |

### CC 端（Claude Code）

CC 端不需要 MCP 工具——直接粘贴链接，Claude 用 WebFetch 就能读。

## 限制

- 视频帖只返回文字和封面图
- 评论只有首屏
- 小红书改版可能需要调整解析逻辑
