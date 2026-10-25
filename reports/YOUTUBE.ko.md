# 1.16.0 YouTube 다운로드 구현과 분석

2026-10-25 기준으로 사용자 제공 저장소와 유지보수되는 추출 엔진을 검토했다. YouTube 영상·Shorts의 공개 단일 VOD를 대상으로, 별도 로컬 도우미로 주소를 추출하고 기존 확장의 다운로드·병합·저장·보안 검사 경로를 사용한다.

## 제공된 Hitomi 저장소 확인

| 대상 | 고정 참조 | 확인한 내용 |
| --- | --- | --- |
| semtle/hitomi-downloader-KR master | `501e71f3d7ab0ccf6bc3a03c91d82d30cf75f04b` · 2020-06-05 | README와 이미지 두 파일 |
| 같은 저장소 v2.0 | `3d1cd37200436a34508ffaf62194263ec0f67842` · 2020-04-10 | VB.NET Windows Forms 소스, .NET 4.6.1, EO.Web 계열 20.0.81 |
| 실제 다운로드 구현 | `hitomi.vb`의 `Manga_Download` | WebClient로 갤러리 이미지를 받은 뒤 PNG 저장 |
| YouTube 구현·라이선스 | 해당 참조의 VB·프로젝트·설정·README 검사 | YouTube 추출 구현과 별도 LICENSE/NOTICE 파일을 발견하지 못함. README의 YouTube 주소는 작성자 채널 링크 |

[사용자 제공 소스의 고정 리비전](https://github.com/semtle/hitomi-downloader-KR/tree/3d1cd37200436a34508ffaf62194263ec0f67842)을 실제로 읽었으며 실행 파일을 실행하거나 코드를 복사하지 않았다. 이 저장소의 이미지 다운로드 코드를 현재 YouTube 추출 구현으로 간주하지 않는다.

## 선택한 구현

공식 [yt-dlp 2026.10.21](https://github.com/yt-dlp/yt-dlp/tree/6ccd977303412151ee23352c6257dd658ffc1987)을 선택했다. 고정 리비전은 `6ccd977303412151ee23352c6257dd658ffc1987`이다. 순수 Python wheel 두 개만 별도 도우미의 격리 환경에 설치하며, FFmpeg 실행 파일이나 yt-dlp의 PyInstaller 배포본을 확장에 넣지 않는다.

| 구성 요소 | 버전 | 설치 파일 SHA-256 |
| --- | --- | --- |
| yt-dlp | 2026.10.21 | `94a3a3e2c423129d0bbd2f1be000c4171fa1226c29e251c84aff868f2851c247` |
| yt-dlp-ejs | 0.8.0 | `79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4` |
| Deno | 최소 2.3.0 · 검토한 권장 2.9.8 | 사용자가 설치한 실행 파일의 실제 절대경로와 버전 확인. 확장·도우미 ZIP에 바이너리를 포함하지 않음 |

설치 프로그램은 `--require-hashes --no-deps`와 공식 PyPI를 사용한다. yt-dlp의 기본 추가 의존성·플러그인·원격 EJS 구성 요소·사용자 설정을 자동으로 가져오지 않는다. 설치 및 사용 방법은 [도우미 안내](../native/YOUTUBE.ko.md)에 있다.

1. 현재 YouTube 페이지는 URL로만 감지하며 이 단계에서 도우미나 사이트로 추가 요청을 보내지 않는다.
2. 사용자가 다운로드를 누르면 최초 저장 폴더 확인 후 전용 `com.myvideoapp.youtube` 도우미로 요청한다.
3. 도우미는 영상 ID·선택 화질·출력 종류·브라우저 식별값을 검증하고 별도 프로세스에서 `extract_info(download=False)`를 실행한다.
4. 최대 두 개의 직접 HTTPS Googlevideo 트랙만 반환한다. 요청 ID·원본 영상 ID·주소·크기·필드 예산을 확장이 검증하고 offscreen에서도 원본과 다시 대조한다.
5. 기존 OPFS 수신과 로컬 FFmpeg Wasm에서 코덱을 복사하여 병합한다. MP4 트랙은 MP4, WebM 트랙은 WebM, 혼합 트랙은 MKV로 보존한다. 음성이 있다고 한 결과에서 실제 음성이 없으면 성공 처리하지 않는다.
6. 실제 파일 형식·전체 해시·내부 위험 검사 이후 기존 Chrome 다운로드·선택적 백신 검사·자동 저장 폴더 절차를 따른다. MP3/M4A는 기존 오디오 변환 한도를 적용한다.

## 경계와 실패 처리

- 도우미는 미디어를 저장하거나 임의 경로·명령·인수·헤더·인증값을 받지 않는다. Chrome 쿠키와 로그인 정보를 읽지 않는다. Deno는 명시된 로컬 실행 파일을 사용하며 서명 처리 코드는 확장 페이지에서 실행하지 않는다.
- 추출은 최대 120초, native 응답은 최대 64KiB, 중간 출력은 최대 1MiB다. 직접 주소는 최대 8KiB이며 자격 증명·포트·잘못된 호스트를 거부한다.
- Chrome 포트 종료·사용자 취소·시간 초과·출력 예산 초과 시 자식과 자손 프로세스를 종료·회수한다. POSIX 프로세스 그룹과 Windows kill-on-close Job Object를 사용한다. Windows API는 이 Linux 환경에서 실제 실행하지 않았다.
- 기록에는 원래의 정규화한 YouTube 페이지 주소만 저장한다. 서명된 직접 주소를 캐시하거나 기록에 보관하지 않으며, 만료 시 재시도에서 다시 추출한다.
- 최고 화질은 실제 제공 해상도를 우선한다. 낮은 상한을 선택하고 그 이하가 없으면 가장 낮은 제공 높이를 사용한다. 특정 코덱을 고정해 최고 화질을 임의로 1080p에 제한하지 않는다.
- 공개 단일 VOD를 지원하며 DRM·라이브·재생목록 일괄 처리·로그인/유료 권한 우회는 지원하지 않는다. 사이트의 추가 토큰 요구, 제공 형식, 만료·프록시/IP 차이로 일부 영상은 추출·다운로드되지 않을 수 있다.

## 검증과 실제 사이트의 구분

보호된 배포 코드를 사용하는 Chromium 검사에서는 실제 H.264/AAC·VP9/Opus·AV1 미디어를 수신해 MP4/WebM/MKV로 병합하고 인코딩 패킷 SHA-256이 유지되는지 검사한다. MP3/M4A 변환, 잘못된 출처·주소, 취소, 만료 주소 재추출, 최초 폴더 설정, 백신 OFF 독립 동작, 시크릿 DB 분리와 설정 UI도 검사한다. Chrome API·native 추출·Googlevideo 응답은 명시적 대역이다.

별도 native 통합 검사는 실제 고정 Python 패키지와 Deno를 사용하며, 오프라인 시험 추출기는 명시적으로 주입한다. 이 결과가 실제 YouTube 페이지의 현재 서명·PO 토큰·사이트 접근 성공을 뜻하지 않는다. 현재 클라우드의 YouTube 네트워크 접근 및 실제 unpacked 확장 설치 제한 때문에 실제 사이트에서의 전체 동작은 검증하지 못했다.

세부 결과는 `youtube.json`, `youtube-native-integration.json`, `native-tests.json`, 전체 버전 검증은 `release-validation.json`과 `VALIDATION.ko.md`를 참고한다. [설정 화면](../test-results/youtube-settings.png)을 함께 제공한다.
