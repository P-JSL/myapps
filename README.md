# My Video App 1.19.0

**Chrome 확장과 Windows 데스크톱 앱을 함께 제공합니다. YouTube는 Windows 앱에서 다운로드합니다.**

Windows 앱에서 **최대 16개 동시 다운로드**와 사이트별 작업 수를 설정할 수 있습니다. 앱 계정·구독·API 키는 필요하지 않습니다. 1.17에서 분리한 Chrome 확장과 Windows 앱의 지원 범위를 유지합니다.

**1.19에서는 대용량 직접 파일의 분할 전송과 HTTP/3 우선 연결을 추가했습니다.** HTTP/3가 가능하지 않으면 HTTP/2·HTTP/1.1로 폴백하며 실제 협상한 프로토콜만 표시합니다. 두 기능과 **앱 전체 다운로드 속도 제한**을 설정에서 ON/OFF할 수 있습니다. 속도 제한은 기본 OFF입니다.

## 다운로드

**[Downloads 폴더에서 설치 파일 받기](Downloads/)** · [최신 Release 전체 보기](https://github.com/P-JSL/myapps/releases/latest)

| 파일 | 사용자에게 필요한 내용 |
| --- | --- |
| **[Windows 앱 ZIP 다운로드](https://github.com/P-JSL/myapps/releases/latest/download/my-video-app-desktop-windows-x64.zip)** | **my-video-app-desktop-windows-x64.zip**을 전부 풀고 **My Video App.exe** 실행. Windows 10/11 x64, Python·yt-dlp·Deno·FFmpeg·Qt 포함 |
| **[Chrome 확장 ZIP](artifacts/my-video-app-extension.zip)** | 영상 감지·일반 미디어·HLS/DASH 다운로드·로컬 미디어 도구. **YouTube 미지원** |
| [전체 소스 ZIP](artifacts/my-video-app-source.zip) | 확장·앱·빌드 스크립트·의존성 잠금·검사 코드 |
| [확장 백신 도우미](artifacts/my-video-app-antivirus-helper.zip) | Chrome 확장의 선택적 로컬 백신 연동. 데스크톱 앱의 YouTube에는 필요하지 않음 |

**Windows 앱 ZIP은 GitHub 일반 Git 파일 제한(100MiB)을 넘으므로 Release에 보관합니다.** 저장소의 [Downloads 폴더](Downloads/)에는 실제 ZIP을 내려받는 링크를 제공합니다. [배포 워크플로](.github/workflows/release.yml)가 버전·코드·고정 의존성으로 앱을 빌드하고 확장 ZIP과 함께 게시합니다. 비공개 저장소의 Release는 권한 있는 계정으로 로그인해야 접근할 수 있습니다.

![Windows 앱 밝은 화면](reports/screenshots/desktop-light.png)

## Windows 앱 사용

1. Release에서 Windows 앱 ZIP을 내려받아 폴더 전체를 압축 해제합니다.
2. **My Video App.exe** 실행 → 최초 다운로드 전에 **저장 폴더 선택**.
3. 영상 주소 붙여 넣기 → 화질·형식 선택 → **다운로드 추가**.
4. 대기열에서 진행률·속도·남은 시간을 확인하고, 완료 후 **폴더 열기**를 누릅니다.

**다운로드마다 저장 창을 띄우지 않습니다.** 저장 폴더는 설정에서 바꿉니다. 최고 화질·해상도 선택, 영상·음성 병합, MP3/M4A 저장, 취소·재시도, 검색 가능한 기록, 밝은/어두운 테마를 제공합니다. 상세 실행법은 [Windows 앱 안내](desktop/README.ko.md)를 참고하세요.

**설정 → 동시 다운로드**에서 자동(PC의 논리 CPU 수에 따라 2~4개) 또는 1~16개를 선택하세요. **같은 사이트 동시 다운로드**는 기본 4개이며 1~16개로 바꿀 수 있습니다. 예를 들어 YouTube 영상 8개를 동시에 진행하려면 두 설정을 모두 8개 이상으로 지정합니다. 기존에 저장한 1개·2개 설정은 유지합니다. 수를 낮춰도 진행 중인 다운로드는 취소하지 않고 완료 후 새 제한을 적용합니다.

조각 다운로드의 전체 예산과 영상 분석·변환·백신 검사 수를 별도로 제한합니다. 작업 수를 늘려도 서버·회선·디스크의 한계를 넘는 속도 향상을 보장하지는 않습니다. [설계와 논문·프로그램 조사](reports/DESKTOP_CONCURRENCY_RESEARCH.ko.md)를 참고하세요.

큰 직접 파일은 서버가 바이트 범위와 강한 ETag를 지원할 때 최대 4개 요청으로 나눠 받습니다. **4개 파일 동시 다운로드의 로컬 속도 제한 시험에서는 분할 전송으로 합계 속도가 약 3.4배 증가했습니다.** 인터넷·YouTube에서 같은 향상을 보장하는 결과는 아닙니다. [시험 조건과 결과](reports/desktop-transfer.json) · [HTTP/3·범위 요청 설계 근거](reports/DESKTOP_TRANSPORT_RESEARCH.ko.md)

**설정 → 다운로드 속도 제한**에서 ON/OFF와 합계 상한(KiB/s)을 지정합니다. 기본 OFF, 저장된 기본 상한은 10,240KiB/s(10MiB/s)이며 진행 중에도 변경할 수 있습니다. 파일별 상한이 아니라 앱 전체의 미디어 데이터 합계에 적용합니다.

## Chrome 확장 설치

1. 확장 ZIP을 풀고 `chrome://extensions`에서 개발자 모드를 켭니다.
2. **압축 해제된 확장 프로그램 로드** → `manifest.json`이 있는 `my-video-app` 폴더 선택.
3. **설정 → 다운로드 저장 폴더**에서 Chrome의 저장 폴더 절대경로를 선택하고 **다운로드 전에 각 파일의 저장 위치 확인을 OFF**로 바꾼 뒤 최초 설정을 완료합니다.
4. 영상 페이지를 새로고침하고 재생 → 확장 아이콘 → 다운로드.

기존 설치는 같은 폴더에 새 ZIP 내용을 갱신하고 확장을 새로고침하세요. **YouTube 주소·재생 조각은 확장에서 다운로드하지 않으며 Windows 앱으로 안내합니다.** 백신 연동은 ON/OFF할 수 있고, Windows Defender 기본 연동 및 다른 백신 연결은 기존 [안내](native/README.ko.md)를 따릅니다.

## 어떤 기능을 어디에서 쓰나요?

| 기능 | Chrome 확장 | Windows 앱 |
| --- | --- | --- |
| **YouTube 영상·음성 다운로드** | 미지원 | **지원: 공개 단일 VOD·Shorts** |
| 일반 미디어·HLS/DASH | 감지·다운로드·병합 | 직접 미디어 주소 다운로드 |
| 최고 화질·MP3/M4A | 제공 트랙 내 선택·변환 | 제공 트랙 내 선택·변환 |
| 긴 영상·대용량 | 디스크 기반 처리, 지원 서버의 병렬 구간 저장 | 디스크 다운로드·FFmpeg 병합, 저장 공간에 따름 |
| 로컬 업스케일링·변환 도구 | 지원 | 이번 버전은 다운로드 중심 |
| 기록·설정 | 브라우저 IndexedDB | 사용자 계정 SQLite |
| 백신 | 선택적 로컬 도우미 + Chrome 보호 | 다운로드 후 Windows 보안 검사 선택 |

**DRM·로그인/유료 권한 우회·라이브 녹화는 지원하지 않습니다.** 사이트의 형식 제공·접근 조건과 변경에 따라 다운로드가 제한될 수 있습니다. `.txt`·HTML 오류 응답을 영상으로 저장하지 않으며 파일의 실제 형식을 확인합니다. 검사 신호 없음이 모든 악성코드 부재를 보장하지는 않습니다.

## 빌드·검사

Node.js 24 이상과 Python 3.11 이상이 필요합니다. 의존성은 고정 URL·해시로 검증하며 개발·빌드 캐시는 패키지에 포함하지 않습니다.

```sh
npm ci
npm run typecheck
npm run build
python3 -B scripts/archive.py
python3 desktop/launcher/build.py --fetch-toolchain
python3 -B scripts/build-desktop.py
```

데스크톱 실행 파일은 Windows x64용입니다. **1.19에서는 이전에 수행한 검사를 건너뛰고 새 전송·HTTP/3·통합 경로와 배포 범위만 검사합니다.** 인증서를 검증한 로컬 HTTP/3·HTTP/2 서버에서 실제 전송을 확인하며, 실제 YouTube 서버를 이용한 속도 측정은 수행하지 않습니다. 빌드의 의존성 해시 확인과 압축 파일 생성은 그대로 수행합니다.

[1.19 변경과 검사 범위](reports/DESKTOP_1_19.ko.md) · [1.18 변경과 검사 범위](reports/DESKTOP_1_18.ko.md) · [저작권·제3자 고지](THIRD_PARTY_NOTICES.md) · [데스크톱 고지](desktop/THIRD_PARTY_NOTICES.md)

## 버전별 패치 내역

최신 버전부터 정리했습니다. 버전은 프로젝트의 `package.json` 기준이며, 분석에 사용한 원본 확장 버전 `10.6.1.2`와 구분합니다. 지원 범위와 검증 한계는 각 문서를 참고하세요.

| 버전 | 주요 변경 | 관련 문서 |
| --- | --- | --- |
| **1.19.0** | 데스크톱의 공개 직접 미디어에 HTTP/3 우선 연결과 HTTP/2·HTTP/1.1 폴백, 강한 ETag·범위를 검증하는 최대 4개 분할 전송, 유한 스트리밍 큐·연결 재사용·제한 재시도 추가. 앱 전체 속도 제한 ON/OFF·상한 실시간 변경, 전송 가속·HTTP/3 설정, 실제 프로토콜 표시와 신규 로컬 전송 시험 | [변경·검사 범위](reports/DESKTOP_1_19.ko.md) · [조사](reports/DESKTOP_TRANSPORT_RESEARCH.ko.md) |
| **1.18.0** | 데스크톱 동시 다운로드 최대 16개, 자동 2~4개, 사이트별 제한 설정과 작업 배분. 조각 다운로드·메타데이터 분석·변환·백신 검사를 별도 자원 예산으로 제어하고 진행률 알림을 줄여 UI 부하 완화. 이전 검사는 건너뛰고 신규 동시성 검사만 수행 | [변경·검사 범위](reports/DESKTOP_1_18.ko.md) · [조사와 설계](reports/DESKTOP_CONCURRENCY_RESEARCH.ko.md) |
| **1.17.0** | 확장의 YouTube 기능 제거. yt-dlp·EJS·Deno·FFmpeg·Python·Qt를 내장한 Windows GUI 앱 추가. 대기열·최고 화질·오디오 저장·취소/재시도·SQLite·테마·폴더 설정, 확장과 앱을 같은 Release에 게시 | [검사 범위](reports/DESKTOP_1_17.ko.md) · [앱 사용법](desktop/README.ko.md) |
| 1.16.0 | YouTube 공개 단일 영상·Shorts의 최고 제공 화질·MP3/M4A 저장 추가. 별도 로컬 yt-dlp/Deno 도우미로 주소 추출 후 기존 브라우저에서 MP4/WebM/MKV 병합·자동 저장·보안 검사 수행. 취소·만료 주소 재추출·시크릿 분리와 별도 도우미 ZIP·Release 첨부 추가 | [YouTube 분석과 검증](reports/YOUTUBE.ko.md) · [도우미 설치](native/YOUTUBE.ko.md) |
| 1.15.0 | 최초 저장 전 폴더 설정 안내와 확인 저장, Chrome에서 선택한 절대경로로 저장 창 없는 다운로드, 설정에서 폴더 변경. 영상·오디오·변환·확대 결과 모두 적용하며 시크릿 확인은 메모리로 분리. GitHub Release에 설치 ZIP 자동 첨부 | [저장 폴더와 자동 저장](reports/DOWNLOAD_FOLDER.ko.md) · [Release 워크플로](.github/workflows/release.yml) |
| 1.14.1 | 아이콘 팝업 너비를 640→720px로 확대하고 미디어 카드·글씨·버튼·여백을 컴팩트하게 조정. 긴 제목·주소는 말줄임과 전체 툴팁 제공, 좁은 화면에서도 다운로드·주소 복사·보안 안내 유지 | [팝업 크기와 배치 개선](reports/POPUP_COMPACT.ko.md) |
| 1.14.0 | 공통 ESM·UTF-8·동일 아이콘 정리와 오프라인 Brotli 엔진 포장으로 기능을 유지하며 배포 경량화. 공식 유사 도구 5개를 조사하고 팝업·전체 앱에 클릭 시 미디어 주소 복사를 독립 구현. 추가 권한·클립보드 읽기·자동 복사 없이 브라우저 복사 실패 시 직접 선택·복사 지원 | [경량화 측정](reports/LIGHTWEIGHT_BUILD.ko.md) · [도구 비교와 기능 선택](reports/COMPETITOR_RESEARCH.ko.md) |
| 1.13.0 | 기가바이트 파일의 구간 병렬 전송과 디스크 병합, HLS/DASH 원본의 디스크 기반 MP4 저장, 전체 파일 증분 SHA-256 추가. 원본 다운로드의 고정 길이·전체 준비 시간·128MiB 한도를 제거하며 저장 공간·서버·목록 분석 예산은 적용 | [대용량·병렬 다운로드](reports/LARGE_DOWNLOADS.ko.md) |
| 1.12.1 | 백신 연동 ON/OFF 추가(기본 ON), 일반 창 설정 저장·시크릿 창 분리, OFF 시 도우미 호출 중단. 내부 데이터 검사·Chrome 보호·기존 위험 경고는 유지하며, OFF 다운로드는 백신 미검사로 표시하고 자동 업스케일링을 제안하지 않음 | [백신 연동 설정](reports/SECURITY_DOWNLOADS.ko.md) |
| 1.12.0 | 앱 내부 정적 위험 신호 검사, 영상 처리 전 위험 입력 차단, 파일 해시·크기에 연결된 검사 결과와 외부 백신과 분리한 확인창 추가. 신호 없음은 안전을 보장하지 않음 | [내부 검사 범위와 한계](reports/INTERNAL_SCAN.ko.md) |
| 1.11.0 | 모던 팝업, 다운로드 검사 추적 실패 처리·미디어 메타데이터 제한 보완, 알려진 위험 디코더 경로 제외, 공개 함수 최소화와 배포 전 최신 npm 감사 적용. 포함 FFmpeg 자체의 모든 취약점을 패치한 것은 아님 | [보안 검토와 남은 엔진 한계](reports/SECURITY_REVIEW_2026-10-21.ko.md) |
| 1.10.0 | 배포 JS/CSS 압축·런타임 파일명 해시화, gzip 후 AES-256-GCM 엔진 포장, 별도 비밀번호 소스 보관 도구 추가. 실행 키가 설치본에 있으므로 역공학 방지를 보장하지 않음 | [배포 보호 방식과 한계](reports/PROTECTED_BUILD.ko.md) |
| 1.9.1 | 형식·인코더·화면 문구 메타데이터 공통화, 백신 요청 수명주기 통합, 설치본의 테스트 번들 제외와 소스 구조 자동 점검 | [리팩토링 분석](reports/REFACTORING.ko.md) |
| 1.9.0 | 어두운 미디어 팝업·영상 다운로드 아이콘·실제 파일 형식에 따른 저장, 설정에서 전체 앱 열기, IndexedDB 자동 생성·기존 데이터 이전·보관 한도 관리. 오류·복구 대기 시 데이터 보존과 자동 정리·확대 제안 보류 | [DB 관리](reports/DATABASE.ko.md) · [팝업·파일 저장 검증](reports/VALIDATION.ko.md#팝업실제-미디어-파일-저장) |
| 1.8.0 | 선형 화질 선택·미디어 ID 색인, 중복 바이트 복사와 변경 없는 화면 재생성 감소, 입력 검증 예산 보완. 기존 출력·보안 검사·호환 조건 유지 | [알고리즘 조사와 실측](reports/ALGORITHMS.ko.md) |
| 1.7.0 | 시크릿 기록·복사 큐 격리, 늦은 위험 경고 시 복사본 철회, 업데이트 후 작업 복구, DASH 오프셋·초기화 상속과 미검사 판정 보완 | [전체 점검과 독립 검토](reports/FULL_AUDIT.ko.md) |
| 1.6.0 | 리디렉션·DASH 상속 호환성, 실제 백신 연결 상태 확인, 화질·저장 형식 기억, 키보드 초점과 확대 제안 수명주기 개선 | [교차 검토·적용 내역](reports/REVIEW_IMPROVEMENTS.ko.md) |
| 1.5.0 | Windows 기본 Defender 우선 선택, 활성 타사 백신의 표준 인터페이스(AMSI) 지원 확인과 자동 연동 | [Windows 백신 자동 선택](reports/VALIDATION.ko.md#150-windows-백신-자동-선택-검증) |
| 1.4.0 | 로컬 백신 자동 검사, 위험·미검사 파일의 삭제·재검사·유지 확인창, Chrome 다운로드 경고 연동 추가 | [자동 백신 검사](reports/SECURITY_DOWNLOADS.ko.md) |
| 1.3.0 | HTTP/3 연결 관측, 다운로드 준비 대기열·취소, 조각 병렬 전송, 일시 오류 재시도와 진행 표시 추가 | [다운로드 개선·HTTP/3](reports/DOWNLOADS_HTTP3.ko.md) |
| 1.2.0 | 최고화질·해상도 선택, MP3/M4A 오디오 다운로드, 로컬 영상·음성 변환과 별도 영상·음성 병합 추가 | [로컬 미디어 기능](reports/FEATURES.ko.md) |
| 1.1.0 | 독립 TypeScript 로컬 다운로드 엔진으로 전환. 원본 서비스·구독·활성화·전용 추출기 제거, 일반 파일·비암호화 HLS/DASH VOD·기록·로컬 확대 제공 | [독립 로컬 모드와 지원 범위](reports/LOCAL_MODE.ko.md) |
| 1.0.0 | 원본 엔진을 보존한 초기 개발 버전. 사이트 브리지·메시지 보안 경계의 TypeScript 재작성과 선택적 로컬 2x/4x 확대를 추가하고, 같은 버전에서 My Video App 이름·배포 ZIP 갱신 | [초기 개발 이력](https://github.com/P-JSL/myapps/commit/905d117) · [이름 변경 이력](https://github.com/P-JSL/myapps/commit/806ef92) |

## 저작권 고지

사용 라이브러리와 제공 이미지의 저작권 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
