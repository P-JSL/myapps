# My Video App 다운로드

**Windows 앱은 정식 v1.19.4를 유지하며, Chrome 확장은 v1.19.4-missav.2에서 일반판과 MissAV 지원판 ZIP을 각각 제공합니다.**

| 파일 | 용도 |
| --- | --- |
| **[my-video-app-desktop-windows-x64.zip](https://github.com/P-JSL/myapps/releases/latest/download/my-video-app-desktop-windows-x64.zip)** | **Windows 10/11 x64 앱. YouTube 다운로드 지원.** Python·yt-dlp·Deno·FFmpeg·Qt 포함 |
| **[my-video-app-extension-missav.zip](https://github.com/P-JSL/myapps/releases/download/v1.19.4-missav.2/my-video-app-extension-missav.zip)** | **MissAV 지원판.** MissAV 플레이어/HLS CDN 감지 추가. 기존 다운로드 기능 유지 |
| **[my-video-app-extension-standard.zip](https://github.com/P-JSL/myapps/releases/download/v1.19.4-missav.2/my-video-app-extension-standard.zip)** | **일반판.** MissAV 전용 코드 없이 기존 다운로드·감지기 유지 |
| [my-video-app-source.zip](https://github.com/P-JSL/myapps/releases/download/v1.19.4-missav.2/my-video-app-source.zip) | 전체 프로젝트 소스 |
| [my-video-app-antivirus-helper.zip](https://github.com/P-JSL/myapps/releases/latest/download/my-video-app-antivirus-helper.zip) | Chrome 확장의 선택적 로컬 백신 도우미. Windows 앱의 YouTube 다운로드에는 필요하지 않음 |
| [SHA256SUMS-RELEASE.txt](https://github.com/P-JSL/myapps/releases/latest/download/SHA256SUMS-RELEASE.txt) | 같은 Release 파일들의 SHA-256 확인값 |

## Windows 앱 실행

1. **my-video-app-desktop-windows-x64.zip**을 다운로드합니다.
2. ZIP **전체를 새 폴더에 압축 해제**합니다. 1.19.4는 1.18 기반 런타임으로 복원하므로 기존 폴더에 덮어쓰지 마세요. 실행 파일과 `runtime`·`desktop` 폴더를 함께 유지하세요.
3. **My Video App.exe**를 실행하고 최초 다운로드 전에 저장 폴더를 선택합니다.

**데스크톱 ZIP은 GitHub 일반 Git 파일 제한(100MiB)을 넘습니다.** 따라서 ZIP 자체는 Release에 보관하고, 이 폴더에서 바로 내려받도록 연결합니다. 저장소의 **Code → Download ZIP**에는 데스크톱 실행 패키지가 포함되지 않습니다.

[최신 Windows Release](https://github.com/P-JSL/myapps/releases/latest) · [Chrome 확장 일반판/MissAV판](https://github.com/P-JSL/myapps/releases/tag/v1.19.4-missav.2) · [Windows 앱 사용법](../desktop/README.ko.md) · [Chrome 확장 설치법](../README.md#chrome-확장-설치)

**참고:** 두 Chrome ZIP을 동시에 설치하지 마세요. 사용할 유형 하나만 선택하세요. MissAV판의 콘텐츠 감지 성공은 CDN 접근 허용·다운로드 성공을 보장하지 않습니다.
