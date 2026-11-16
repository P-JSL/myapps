# My Video App 다운로드

**[통합 릴리즈 v1.20.1-preview.1](https://github.com/P-JSL/myapps/releases/tag/v1.20.1-preview.1)에서 세 가지 설치 파일을 각각 받을 수 있습니다.** MissAV 확장과 Windows 앱의 403 요청 처리를 개선했습니다. 일반판 확장은 기존 파일 그대로입니다.

| 파일 | 용도 |
| --- | --- |
| **[my-video-app-desktop-windows-x64.zip](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/my-video-app-desktop-windows-x64.zip)** | **Windows 10/11 x64 앱. YouTube 다운로드 지원.** Python·yt-dlp·Deno·FFmpeg·Qt 포함. MissAV 페이지·감지된 m3u8 직접 주소 지원 |
| **[my-video-app-extension-missav.zip](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/my-video-app-extension-missav.zip)** | **MissAV 감지 추가판(실험판).** 실제 HLS 주소 보존·원래 재생 페이지를 통한 요청. 다운로드 중 원래 탭 유지 |
| **[my-video-app-extension-standard.zip](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/my-video-app-extension-standard.zip)** | **일반판.** MissAV 전용 코드 없이 기존 다운로드·감지기 유지 |
| [my-video-app-source.zip](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/my-video-app-source.zip) | 현재 커밋의 전체 프로젝트 소스와 점검 보고서 |
| [my-video-app-antivirus-helper.zip](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/my-video-app-antivirus-helper.zip) | Chrome 확장의 선택적 로컬 백신 도우미. Windows 앱의 YouTube 다운로드에는 필요하지 않음 |
| [SHA256SUMS-RELEASE.txt](https://github.com/P-JSL/myapps/releases/download/v1.20.1-preview.1/SHA256SUMS-RELEASE.txt) | 통합 릴리즈 파일들의 SHA-256 확인값 |

## Windows 앱 실행

1. **my-video-app-desktop-windows-x64.zip**을 다운로드합니다.
2. ZIP **전체를 새 폴더에 압축 해제**합니다. 새 통신 구성요소가 포함되므로 기존 폴더에 덮어쓰지 마세요. 실행 파일과 `runtime`·`desktop` 폴더를 함께 유지하세요.
3. **My Video App.exe**를 실행하고 최초 다운로드 전에 저장 폴더를 선택합니다.

**데스크톱 ZIP은 GitHub 일반 Git 파일 제한(100MiB)을 넘습니다.** 따라서 ZIP 자체는 Release에 보관하고, 이 폴더에서 바로 내려받도록 연결합니다. 저장소의 **Code → Download ZIP**에는 데스크톱 실행 패키지가 포함되지 않습니다.

[통합 릴리즈](https://github.com/P-JSL/myapps/releases/tag/v1.20.1-preview.1) · [정식 Windows Release](https://github.com/P-JSL/myapps/releases/latest) · [검사 및 원본 버전](../reports/MISSAV_1_20_1.ko.md) · [Windows 앱 사용법](../desktop/README.ko.md) · [Chrome 확장 설치법](../README.md#chrome-확장-설치)

**참고:** 두 Chrome ZIP을 동시에 설치하지 마세요. 사용할 유형 하나만 선택하세요. MissAV판의 콘텐츠 감지 성공은 CDN 접근 허용·다운로드 성공을 보장하지 않습니다.
