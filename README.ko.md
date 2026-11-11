# Widal Factory

소프트웨어 팩토리를 관리하는 웹 앱입니다. [Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui)에서 개발합니다.

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

현재는 React 브라우저 클라이언트와 Bun 브리지를 통해 herdr의 워크스페이스, 에이전트 대화, 확인 카드, 파일, 터미널을 제공합니다. 터미널과 에이전트 상태는 herdr가 관리합니다. Factory 전용 페이지, 공통 로그인, Setup은 아직 통합되지 않았습니다. 이 저장소만으로 완성된 호스팅 서비스를 제공하지는 않습니다.

## 소스에서 실행

Git, Bun 1.4 이상(CI는 1.4.2), 실행 중인 herdr 0.9.0 이상이 필요합니다. Linux/macOS 터미널 연결에는 Rust PTY 호스트나 대체 경로인 Node 18 이상이 필요합니다. 둘 다 없으면 화면을 미러링합니다. Windows는 미러링을 사용합니다. [설정 안내](INSTALL.md)를 확인하세요.

```bash
git clone https://github.com/Widal-Inc/factory-web-ui.git
cd factory-web-ui
bun install --frozen-lockfile
```

첫 번째 터미널에서 상위 프로젝트의 텔레메트리를 끄고 실행합니다.

```bash
OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1 bun run server
```

다른 터미널에서 실행합니다.

```bash
bun run dev
```

`http://localhost:5173`을 여세요. Vite가 API와 WebSocket 요청을 포트 7317로 전달합니다. QA에는 별도 herdr 테스트 세션을 사용하세요. 빌드된 클라이언트는 `bun run build` 후 같은 서버 명령을 실행하고 `http://127.0.0.1:7317`을 열면 됩니다. PowerShell 환경 변수 설정은 [INSTALL.md](INSTALL.md)에 있습니다.

## 현재 범위

지원되는 에이전트의 대화를 읽고, 확인 카드에 답하고, 터미널과 선택한 PC의 파일 및 변경 사항을 볼 수 있습니다. 연결이 끊겨도 보내지 않은 초안은 남으며 전송은 명시적인 사용자 동작이 필요합니다. [원격 PC](docs/remote-pcs.md)의 런타임 배포는 별도 통합 작업이 필요합니다.

UI, 아이콘, 설치 프로그램, 서비스 코드는 아직 전환 중입니다. Widal 설치 URL, 공개 데모, 네이티브 앱 다운로드, 릴리스 채널은 여기서 제공하지 않습니다. 상위 프로젝트의 설치 프로그램, 계정, 릴레이, 페어링, 업데이트 기능으로 이 포크를 설정하지 마세요. [배포 상태](docs/app-updates.md)를 확인하세요.

실행 예시는 `OVIS_TELEMETRY=0`으로 상위 프로젝트의 텔레메트리를 비활성화합니다. 이 문서가 해당 구현을 삭제하거나 Widal 전송 주소를 추가하지는 않습니다. 계정이 필요 없다거나, PC 밖으로 아무것도 전송되지 않는다거나, 공통 로그인이 이미 적용됐다고 가정하지 마세요. [접근 및 데이터](docs/guide.md#access-and-safety)를 확인하세요.

## 문서와 기여

- [사용자 가이드](docs/guide.md), [개발 및 검사](docs/development.md), [기여 안내](CONTRIBUTING.md), [에이전트 지침](AGENTS.md)
- [포크 문서 감사와 호환성 이름](docs/fork-status.md), [디자인](DESIGN.md), [과거 변경 기록](CHANGELOG.md)
- [버그 신고](https://github.com/Widal-Inc/factory-web-ui/issues), [비공개 보안 신고](SECURITY.md)

## 상위 프로젝트 출처

Widal Factory는 [Ovis](https://github.com/devswha/ovis)의 포크입니다. 원저작권, 법적 고지, 저자 기록을 보존합니다. 기존 아트워크는 상속한 것이며, 이 문서는 새 Widal 로고를 제공하지 않습니다.

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

[MIT](LICENSE). Copyright © 2026 devswha. [Third-party notices](THIRD_PARTY_NOTICES.md).
