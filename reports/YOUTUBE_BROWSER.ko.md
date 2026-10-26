# YouTube 브라우저 내부 다운로드 (v1.16.2)

Python, Deno, yt-dlp EXE 및 Native Messaging 호스트 없이 **Chrome 확장 프로그램 내부**에서 공개 영상 페이지의 `ytInitialPlayerResponse` JSON 데이터를 읽어 직접 다운로드 가능한 HTTPS `*.googlevideo.com/videoplayback` 형식만 선택합니다. 원래 `v1.16.0`의 대용량 다운로드, FFmpeg 병합, MP3/M4A 변환, 저장 위치, 내부 정적 검사, 선택적 백신 검사를 재사용합니다.

**지원 범위:** 공개된 일반 단일 YouTube VOD/Shorts 중 플레이어 응답에 암호화되지 않은 직접 스트림 URL이 존재하는 경우. 서명 해독, 외부 실행 파일 호출, 로그인/쿠키 추출, DRM, PO 토큰 생성, 원격 JavaScript 실행, 제한 영상, 재생목록 일괄 다운로드 및 라이브 녹화는 지원하지 않습니다. 직접 스트림에 요구되는 CORS·서버 정책 및 유효기간에 따라 실패할 수 있습니다. **yt-dlp 전체 호환 구현이 아닙니다.**

YouTube의 서비스 정책 및 영상 권리자의 허락을 지켜 사용하세요. 기존 설치의 확장 프로그램 ID는 사용자가 설치한 패키지 서명/경로에 따라 달라질 수 있으며 YouTube 추출에는 ID 고정이 필요하지 않습니다. 백신용 Native Messaging은 기존 선택 기능으로 유지합니다.

검증 범위: 브라우저 추출 알고리즘에 대한 합성 플레이어 JSON 단위 테스트를 추가했습니다. 실제 YouTube 네트워크·Chrome 설치·영상 다운로드 성공은 이 소스 커밋에서 검증하지 않았습니다. 배포 ZIP은 별도 의존성 확보 및 빌드·검증이 필요합니다.
