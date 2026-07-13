# xhs-search-mcp v2.0

小红书搜索 + 读取 MCP 工具。

## 功能

### xhs_search - 搜索笔记
输入关键词，返回相关笔记列表（标题、作者、点赞数、链接）。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyword | string | 是 | 搜索关键词 |
| limit | int | 否 | 返回数量，默认20，最大50 |
| sort | string | 否 | general(综合)/popularity(最热)/time(最新)，默认general |

### xhs_read - 读取笔记
输入小红书链接，返回完整笔记内容、评论和图片。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 小红书链接 |
| include_images | bool | 否 | 是否返回图片，默认true |

## 环境变量

| 变量名 | 说明 |
|--------|------|
| XHS_WEB_SESSION | 小红书web_session cookie值 |
| XHS_A1 | 小红书a1 cookie值 |
| XHS_WEB_ID | 小红书webId cookie值 |

## 部署

1. push到GitHub
2. Render新建Web Service，连接该仓库
3. 设置环境变量 XHS_WEB_SESSION, XHS_A1, XHS_WEB_ID
4. Build Command: `npm install`
5. Start Command: `npm start`

## Cookie获取方法

1. 浏览器打开 xiaohongshu.com 并登录
2. F12 → Application → Cookies → xiaohongshu.com
3. 找到 web_session、a1、webId 三个值
4. 填入Render环境变量

Cookie过期后重新登录获取即可。