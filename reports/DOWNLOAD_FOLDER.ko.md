# 1.15.0 다운로드 폴더와 자동 저장

첫 다운로드 전에 **설정 → 다운로드 저장 폴더**에서 저장 위치를 정한다. 기본 위치는 운영체제의 Downloads(다운로드) 폴더다. **저장 폴더 변경**을 누르면 Chrome의 다운로드 설정이 열리며, 위치 → 변경에서 원하는 절대경로의 폴더를 선택하고 **다운로드 전에 각 파일의 저장 위치 확인을 OFF**로 바꾼다. 앱에 돌아와 확인란을 체크하고 최초 설정 완료를 누른 다음 원래 화면에서 다운로드를 다시 누른다.

## 적용 범위

| 동작 | 처리 |
| --- | --- |
| 팝업·전체 앱에서 다운로드 | 설정 확인 전에는 준비·전송·기록 생성을 시작하지 않고 설정 화면으로 안내 |
| 주소 직접 입력·실패 재시도·단축키 | 같은 중앙 확인 절차 적용 |
| MP3/M4A·HLS/DASH·일반 파일 | 실제 형식의 파일명을 유지하고 선택 폴더에 저장 |
| 변환·병합·확대 결과 저장 | 같은 최초 설정 확인 적용. 설정 중에는 현재 탭의 결과를 유지하고 다시 저장 가능 |
| 같은 이름의 기존 파일 | 덮어쓰지 않고 Chrome이 번호를 붙여 저장 |
| 설정에서 폴더 변경 | 같은 Chrome 다운로드 설정을 다시 열며 다음 저장부터 변경 위치 적용 |
| 일반 창 | 설정을 완료했다는 확인만 내장 DB에 저장 |
| 시크릿 창 | 일반 DB를 사용하지 않고 해당 실행 메모리에 확인 상태만 유지 |
| 설정 읽기·저장 오류 | 전송 시작을 보류하고 다시 불러오기 제공 |

## 브라우저 설정의 의미

Chrome 확장은 기본 다운로드 폴더의 절대경로를 직접 읽거나 변경할 수 없다. 다운로드 API의 filename은 Downloads 기준 상대 파일명이어야 한다. 따라서 실제 폴더는 Chrome이 관리하며 앱에 경로 입력란을 두어 무시하거나 다른 위치로 저장하지 않는다. 이 변경은 다른 Chrome 다운로드에도 적용된다.

앱의 확인은 사용자가 Chrome 설정을 마쳤다는 확인이며 **앱이 경로·매번 묻기 옵션을 자동 검증했다는 뜻이 아니다**. 두 저장 경로 모두 saveAs:false를 사용하지만 Chrome의 매번 저장 위치 확인 옵션이 켜져 있으면 Chrome이 창을 띄울 수 있다. 이 때문에 최초 설정에서 해당 옵션을 끄도록 안내한다. 폴더 쓰기 권한·조직 정책·Chrome 위험 파일 확인으로 필요한 추가 안내는 유지한다.

Chrome 기본 보호와 기존 내부 검사·백신 검사·위험 확인 절차는 계속 적용한다. 브라우저 설정을 수정하는 네이티브 쓰기 도우미나 추가 권한을 도입하지 않는다.

## 근거와 검증

공식 Chromium의 [다운로드 API 스키마](https://github.com/chromium/chromium/blob/main/chrome/common/extensions/api/downloads.webidl), [파일명 검사와 saveAs 처리](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/downloads/downloads_api.cc), [저장 위치 확인 판단](https://github.com/chromium/chromium/blob/main/chrome/browser/download/download_target_determiner.cc)을 검토했다.

검증은 보호된 배포 background/UI·실제 Chromium DOM·IndexedDB를 사용한다. 확장 API와 미디어 준비는 명시적 대역이며, 실제 사용자 프로필의 다운로드 위치나 브라우저 설정은 변경하지 않는다. 새 최초 설정·자동 저장 검사는 download-folder.json에 기록하며 기존 파일 바이트·병렬 전송·기가바이트·장시간·보안·시크릿 회귀 검사도 유지한다. 상세 최종 결과와 한계는 VALIDATION.ko.md와 release-validation.json에 기록한다.

[최초 설정 화면](../test-results/download-folder-setup.png)

## GitHub Release

1.15.0부터 main의 새 버전·설치 ZIP 반영 시 .github/workflows/release.yml이 v버전 Release와 my-video-app-extension.zip 첨부를 생성한다. 버전·SHA-256·ZIP 경로와 무결성을 확인하고, 이미 다른 커밋을 가리키는 태그를 덮어쓰지 않는다. 저장소 공개 범위를 변경하지 않으며 비공개 저장소 파일은 접근 권한이 필요하다. 게시 실행 상태는 GitHub Actions와 Release에서 확인한다.
