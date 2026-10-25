# 1.16.1 YouTube 도우미 API 오류 수정

사용자가 제공한 실패 기록은 `chrome.runtime.connectNative is not a function`이었다. 이는 도우미에서 영상 추출이 실패한 결과가 아니라 브라우저가 해당 호출 API를 제공하지 않는 상태에서 함수를 호출한 오류다. 도우미 미설치는 보통 포트 연결 종료 오류이며 이 오류와 구분한다.

## 수정

- `nativeMessaging`을 선택 권한에서 시작 시 필요한 필수 권한으로 옮겼다. 지원하는 데스크톱 Chrome에서 도우미 API를 사용할 권한을 확장 시작 시 확보한다.
- 실제 `connectNative` 함수가 있는지 호출 전에 확인한다. 사용할 수 없는 컨텍스트·브라우저에서는 원시 TypeError 대신 PC Chrome에서 확장을 업데이트·새로고침하라는 안내를 표시한다.
- 영상 추출·트랙 병합·파일 저장·백신 소스와 도우미 실행 파일은 변경하지 않았다. 백신 연결 ON/OFF도 기존 동작을 따른다.

새 설치 ZIP을 기존 설치 폴더에 반영하고 `chrome://extensions`에서 확장을 새로고침해야 새 권한 선언이 적용된다. Chrome이 권한 확인을 표시하면 확장을 다시 사용 설정한다. 설치 폴더를 유지하면 기존 확장 ID에 등록한 도우미를 그대로 사용할 수 있다. 아직 YouTube 도우미를 설치하지 않았다면 기존 YOUTUBE.ko.md 안내에 따라 별도 설치가 필요하다.

## 간단 검증만 실행

사용자의 명시적인 요청에 따라 새 오류 회귀 검사 3개와 타입 검사만 실행한다. 검사 항목은 필수 권한 선언, 권한 보유 상태에서도 API가 없는 환경의 안내, API가 있는 환경에서 요청에 연결된 영상·음성 추출 응답과 포트 정리다. 브라우저 API는 대역이며 실제 사용자 Chrome이나 YouTube 사이트에서 성공했다는 의미가 아니다.

기존 전체 단위·네이티브·브라우저·HTTP/3·알고리즘·npm 감사는 재실행하지 않는다. 기존 1.16.0 보고서는 역사적 결과로 보존하며 1.16.1 통과 결과로 재표기하지 않는다. 현재 빌드와 소스, 간단 검증 결과는 native-api-hotfix.json 및 release-validation.json에 기록한다. 패키지는 같은 archive.py로 만들고 파일 구성·CRC·체크섬만 확인한다.

공식 Chromium은 nativeMessaging을 선택 권한으로도 허용하고 권한 변경 시 바인딩을 갱신하려고 한다. 따라서 선택 권한이 모든 Chrome에서 항상 갱신되지 않는다는 결론을 내리지 않는다. 이번 수정은 시작 시 권한 확보와 실제 API 가용성 확인에 초점을 둔다. 이미 활성화된 필수 권한을 요청하면 permissions.request는 true를 반환하므로 기존 클릭 처리를 유지한다.

근거: [runtime API 기능 조건](https://github.com/chromium/chromium/blob/main/extensions/common/api/_api_features.json), [권한·플랫폼 조건](https://github.com/chromium/chromium/blob/main/extensions/common/api/_permission_features.json), [권한 요청 구현](https://github.com/chromium/chromium/blob/main/extensions/browser/api/permissions/permissions_api.cc).
