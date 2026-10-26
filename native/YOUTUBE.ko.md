# YouTube 다운로드 도우미 설치

**확장 ZIP만 설치하면 YouTube 전용 주소 추출은 동작하지 않습니다.** YouTube용 로컬 도우미와 Deno를 한 번 설치한 뒤 앱 설정에서 연결하세요. 백신 도우미와는 별도이며 백신 연동 ON/OFF와 관계없이 사용자가 요청한 YouTube 주소만 처리합니다.

## 준비

1. Python **3.10 이상**과 공식 [Deno](https://deno.com/) **2.3.0 이상**을 설치합니다. 검토한 권장 버전은 Deno **2.9.8**입니다. Deno 실행 파일은 심볼릭 링크가 아닌 실제 절대경로를 사용하세요. POSIX 환경에서는 실행 파일이 현재 계정이나 root 소유이고, 다른 사용자가 실행 파일이나 상위 경로를 바꿀 수 없는 위치여야 합니다.
2. 전체 소스 ZIP을 풀고 해당 프로젝트 폴더를 엽니다. 별도 YouTube 도우미 ZIP을 풀었다면 아래 `native/install_youtube.py`를 `install_youtube.py`로 바꿉니다.
3. Chrome에 **My Video App** 확장 프로그램을 설치하고 활성화합니다. 도우미 설치기가 확장 ID `kjlhlmbokcdokcmfhbmdbfkkgoacclff`를 우선 확인하고, 없으면 현재 사용자 Chrome 프로필에서 동일한 이름·권한 구성을 가진 활성 확장 ID를 확인합니다. 자동 감지가 안 되거나 복수 후보가 발견되면 `--extension-id`로 직접 지정합니다.

Windows PowerShell 예시:

```powershell
py -3 native/install_youtube.py --deno "C:\Users\사용자\.deno\bin\deno.exe"
```

Linux/macOS 예시:

```sh
python3 native/install_youtube.py --deno "/home/사용자/.deno/bin/deno"
```

macOS에서는 `/Users/사용자/...`처럼 실제 Deno 경로로 바꿉니다. Chromium은 `--browser chromium`, 두 브라우저에 등록하려면 `--browser both`를 추가합니다. 경로에 공백이 있으면 따옴표로 감싸세요. Windows 설치 경로의 명령 셸 특수문자는 허용하지 않습니다.

설치 프로그램은 현재 OS 계정의 전용 폴더에 격리 Python 환경을 만들고 **yt-dlp 2026.10.21**과 **yt-dlp-ejs 0.8.0**의 해시가 일치하는 순수 Python wheel 두 개만 공식 PyPI에서 설치합니다. 기본 추가 패키지·다른 실행 파일·자동 업데이트를 설치하지 않습니다. 설치 과정에는 인터넷 연결이 필요하며 프록시/CA와 TLS 검증을 유지합니다. 관리자 권한이나 OS/Chrome 보호 설정 변경은 필요하지 않습니다.

설치 후 확장을 새로고침하고 앱 설정의 YouTube 도우미 연결을 선택하세요. Chrome의 native messaging 조직 정책에 의해 차단되면 관리자가 허용해야 하며 앱은 해당 정책을 우회하지 않습니다.

## 저장과 지원 범위

- 도우미는 영상 ID·제목과 선택한 영상/음성의 직접 주소만 추출합니다. 도우미가 영상을 내려받거나 임의 폴더에 파일을 쓰지 않습니다.
- 실제 수신·병합·저장은 확장이 처리하며 기존 최초 저장 폴더 설정, Chrome 다운로드 보호, 앱 내부 검사 및 선택적 로컬 백신 검사 흐름을 유지합니다.
- 공개된 단일 녹화 영상의 제공 화질과 MP3/M4A 저장을 지원합니다. 계정 쿠키를 자동으로 읽거나 Chrome 로그인 상태를 도우미로 복사하지 않습니다.
- DRM·라이브 녹화·재생목록 일괄 처리·로그인/유료 권한 우회는 지원하지 않습니다. 영상별 제공 형식, YouTube의 요구사항과 변경, 주소 만료, 네트워크/프록시의 IP 차이 때문에 다운로드할 수 없는 영상이 있을 수 있습니다.
- JavaScript 서명 처리는 별도 Deno 프로세스에서 수행합니다. 확장 페이지에서 외부 JavaScript를 eval하지 않으며, 원격 EJS 구성 요소나 사용자 yt-dlp 설정·플러그인을 로드하지 않습니다.

## 설치 위치와 제거

| OS | 현재 계정의 도우미 폴더 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\MyVideoApp\YouTube` |
| macOS | `~/Library/Application Support/My Video App/youtube` |
| Linux | `~/.local/share/my-video-app-youtube` |

설정 파일 `youtube-config.json`에는 Deno 실행 파일의 절대경로만 기록합니다. 계정 비밀번호·쿠키·다운로드 미디어를 보관하지 않습니다. Python이나 Deno 경로를 옮겼다면 설치 명령을 다시 실행하세요.

```sh
python3 native/install_youtube.py --uninstall
# Windows: py -3 native/install_youtube.py --uninstall
```

처음 등록한 브라우저와 같은 `--browser`를 지정하세요. 선택한 브라우저의 등록과 도우미 고정 파일만 제거하며, 다른 브라우저 등록이 있으면 공용 파일을 유지합니다. 임의 데이터의 재귀 삭제를 피하기 위해 전용 폴더의 `venv`는 남깁니다. 필요하면 등록 제거 후 위 표의 본인 도우미 폴더를 직접 삭제하세요.

yt-dlp의 PyPI 소스/wheel은 Unlicense이며 EJS는 Unlicense 및 포함 구성 요소의 MIT/ISC 고지를 따릅니다. Hitomi Downloader 소스를 복제하거나 배포하지 않습니다. 실제 YouTube 사이트 접근 성공은 로컬 환경과 사이트 조건에 따라 추가 확인이 필요합니다.

## 확장 ID 자동 감지

설치기는 기본 ID `kjlhlmbokcdokcmfhbmdbfkkgoacclff`가 해당 Chrome 사용자 프로필에서 활성화되어 있는지 먼저 확인합니다. 없으면 활성화된 `My Video App` 확장 중 매니페스트 이름·버전·Native Messaging 선택 권한이 일치하는 단일 ID를 사용합니다. 여러 후보가 발견되면 잘못된 확장에 로컬 호스트 권한을 주지 않도록 자동 등록하지 않습니다. 사용자 프로필 파일을 수정하지 않습니다.

브라우저에 확장 프로그램을 **등록하는 것만으로는** OS 실행 파일이나 Native Messaging 레지스트리를 설치할 수 없습니다. Chrome 보안 제한상 한 번은 로컬 설치 프로그램을 직접 실행해야 합니다. 그 후에는 ID 수동 입력 없이 연결할 수 있습니다. 원하지 않는 확장 프로그램에 권한을 부여하지 않도록 `allowed_origins`는 감지된 ID만 포함합니다.
