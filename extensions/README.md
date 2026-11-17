# Chrome 확장 설치 폴더

| 폴더 | 버전 |
| --- | --- |
| [standard](standard/) | 기본판. 기존 원본 감지·다운로드 로직 |
| [missav](missav/) | MissAV 포함판. 원본 탭을 통한 CDN 요청·직접 주소·재시도 지원 |

각 폴더의 `manifest.json` 옆에 실행에 필요한 파일이 모두 들어 있습니다. Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램 로드**로 둘 중 한 폴더를 선택하세요. 두 버전을 동시에 설치하지 마세요. 업데이트 후 재생 탭을 새로고침하세요.

두 폴더를 새로 빌드하려면 저장소 루트에서 `npm ci` 후 `npm run build:extensions`를 실행하세요. `dist/`는 빌드 중간 폴더입니다. 각 빌드의 파일 목록은 `reports/build-standard.json`, `reports/build-missav.json`에 기록됩니다.

릴리즈 ZIP은 각각 `my-video-app-standard/`, `my-video-app-missav/` 폴더로 압축 해제됩니다. Windows 통합 앱은 별도의 `my-video-app-desktop-windows-x64.zip`을 사용합니다.
