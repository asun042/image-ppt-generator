# 项目上下文

## 项目概述

**PPT Generator** - AI驱动的演讲PPT生成工具

从演讲底稿一键生成专业PPT，支持Word文档、XMind思维导图和文本输入，通过AI自动生成脚本拆分、设计稿和PPT图片，最终导出为PPTX文件。所有AI API由用户自行配置，通过内置代理服务器解决CORS跨域问题。

### 版本技术栈

- **项目类型**: 原生静态 HTML + Node.js 代理服务器（native-static）
- **样式**: Tailwind CSS（CDN）
- **文件解析**: mammoth.js（docx）、JSZip（xmind）
- **PPTX生成**: PptxGenJS
- **拖拽排序**: SortableJS
- **状态管理**: localStorage
- **代理服务器**: Node.js（解决CORS跨域问题）

## 目录结构

```
├── index.html          # 主页面
├── app.js              # 应用逻辑（含 proxyFetch 代理调用）
├── server.js           # Node.js 代理服务器（静态文件 + API代理）
├── styles/
│   └── main.css        # 自定义样式
└── .coze               # 配置文件
```

## 功能流程

1. **步骤1 - 演讲底稿**: 上传Word/XMind文件或粘贴文本 + 参考图片
2. **步骤2 - 脚本拆分**: AI生成脚本，用户可拖拽编辑
3. **步骤3 - 设计稿**: AI生成每页设计思路 + 全局设计语言
4. **步骤4 - 图片生成**: AI生成PPT图片，用户可调整
5. **步骤5 - 导出下载**: 导出带/无备注的PPTX文件

## API配置

用户需要在"设置"中配置以下API：
- **文本API**: OpenAI兼容格式（baseUrl + apiKey + model）或 Anthropic格式
- **图片API**: 支持Chat格式（/v1/chat/completions）和Images格式（/v1/images/generations）

所有API请求通过内置代理服务器（`/api/proxy`）转发，解决浏览器CORS跨域限制。

## 包管理规范

本项目无npm依赖，所有库通过CDN引入。Node.js仅用于代理服务器。

## 开发规范

- 代码使用原生 JavaScript（ES6+），无框架依赖
- 状态通过 localStorage 持久化
- AI调用通过 `proxyFetch()` 经代理服务器转发，避免CORS问题
- 代理服务器（server.js）：静态文件服务 + `/api/proxy` 端点转发外部API请求
- 注意CORS限制：用户配置的API需要支持跨域访问
