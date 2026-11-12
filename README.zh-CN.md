# Widal Factory

用于管理软件工厂的 Web 应用，在 [Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui) 中开发。

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

当前提供 React 浏览器客户端和 Bun 桥接服务，用于访问 herdr 的工作区、智能体对话、确认卡片、文件和终端。终端和智能体状态由 herdr 管理。Factory 专用页面、统一登录和 Setup 尚待集成；克隆本仓库并不会获得已完成的托管服务。

## 从源码运行

需要 Git、Bun 1.4 或更高版本（CI 固定为 1.4.2），以及已运行的 herdr 0.9.0 或更高版本。Linux/macOS 的终端连接需要 Rust PTY 主机，或作为后备的 Node 18 以上版本。两者均不可用时使用屏幕镜像。Windows 使用镜像。详见[设置说明](INSTALL.md)。

```bash
git clone https://github.com/Widal-Inc/factory-web-ui.git
cd factory-web-ui
bun install --frozen-lockfile
```

在第一个终端中禁用继承的上游遥测并启动服务：

```bash
OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1 bun run server
```

在另一个终端中运行：

```bash
bun run dev
```

打开 `http://localhost:5173`。Vite 将 API 和 WebSocket 请求转发到 7317 端口。QA 请使用单独的 herdr 测试会话。如需使用构建后的客户端，先运行 `bun run build`，再运行相同的服务命令，并打开 `http://127.0.0.1:7317`。PowerShell 的环境变量设置见 [INSTALL.md](INSTALL.md)。

## 当前范围

可以阅读受支持智能体的对话、回答确认卡片、使用终端，以及查看所选电脑的文件和更改。断线后未发送的草稿会保留，发送需要用户明确操作。[远程电脑](docs/remote-pcs.md)的运行时分发仍需单独集成。

界面、图标、安装程序和服务代码仍在调整。这里没有已确立的 Widal 安装地址、公开演示、原生应用下载或发布渠道。不要使用上游安装程序、账号、中继、配对或更新功能来设置此分支。详见[分发状态](docs/app-updates.md)。

运行示例通过 `OVIS_TELEMETRY=0` 禁用上游遥测。这份文档不会删除相关实现，也不会添加 Widal 遥测地址。不要据此假定应用无需账号、没有任何数据离开电脑，或统一登录已经生效。请阅读[访问和数据说明](docs/guide.md#access-and-safety)。

## 文档与贡献

- [用户指南](docs/guide.md)、[开发与检查](docs/development.md)、[贡献指南](CONTRIBUTING.md)、[智能体说明](AGENTS.md)
- [分支文档审计与兼容性名称](docs/fork-status.md)、[设计](DESIGN.md)、[历史更改记录](CHANGELOG.md)
- [报告问题](https://github.com/Widal-Inc/factory-web-ui/issues)、[私下报告安全问题](SECURITY.md)

## 上游来源

Widal Factory 基于 [Ovis](https://github.com/devswha/ovis) 分支开发。保留上游版权、法律声明和作者记录。现有美术素材继承自上游；此文档不提供新的 Widal 标志。

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

[MIT](LICENSE). Copyright © 2026 devswha. [Third-party notices](THIRD_PARTY_NOTICES.md).
