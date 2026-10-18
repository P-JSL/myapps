# My Video App 로컬 백신 연결

Chrome 확장은 운영체제 백신을 직접 실행할 수 없어 이 별도 동반 프로그램을 사용합니다. Python **3.11 이상**과 ClamAV 또는 지원되는 Microsoft Defender가 필요합니다. 프로그램은 파일·해시를 서버에 전송하지 않으며 사용자 계정에만 설치됩니다. 관리자 권한을 요구하거나 브라우저·백신의 보호 설정을 바꾸지 않습니다.

## 설치

1. 확장을 설치한 후 `chrome://extensions`에서 **My Video App의 확장 ID**를 복사합니다. 설치 위치가 달라지면 ID가 바뀔 수 있습니다.
2. 로컬 백신을 준비합니다. Linux/macOS에는 ClamAV와 현재 서명 데이터베이스가 필요하며, Windows에서도 ClamAV를 사용할 수 있습니다. ClamAV 서명 업데이트는 운영체제의 정상 업데이트 도구로 별도 관리합니다.
3. 전체 소스 ZIP을 풀고 해당 프로젝트 폴더에서 실행합니다. 별도 도우미 ZIP을 푼 경우에는 아래 `native/install.py`를 `install.py`로 바꾸세요. 아래 ID를 실제 ID로 바꾸세요.

```sh
# Linux / macOS
python3 native/install.py --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Windows (설치된 Python 3.11 이상)
py -3 native/install.py --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Chromium은 `--browser chromium`, 둘 다 등록하려면 `--browser both`를 추가합니다. ClamAV가 표준 설치 경로에 없다면 `--clamav /absolute/path/to/clamscan`(Windows는 `C:\...\clamscan.exe`)을 추가합니다. 임의 명령·추가 인수는 허용하지 않습니다. Python 실행 파일의 절대 경로가 기록되므로 Python을 옮기거나 삭제하면 다시 설치해야 합니다. Chrome의 조직 정책이 native messaging을 차단하면 관리자가 허용해야 하며 이 프로그램은 정책을 우회하지 않습니다.

확장을 새로고침한 후 앱에서 **로컬 백신 연결**을 누르고 선택 권한을 허용하면 다음 완료된 다운로드부터 자동 검사가 작동합니다. 동반 프로그램이나 백신이 없거나, 검사 실패·시간 초과가 발생하면 **검사하지 못함**으로 표시합니다. 이를 안전 판정으로 바꾸지 않습니다. 검사 완료 전에는 파일을 열지 마세요. 확장이 완료된 다운로드의 경로를 받은 뒤 검사하므로 Chrome의 다운로드 폴더에는 파일이 먼저 생성됩니다.

### Windows Defender와 개인정보

Defender는 운영체제 정책에 따라 클라우드 보호·샘플 제출을 사용할 수 있습니다. 엄격한 로컬 검사 약속을 지키기 위해 이 프로그램은 기존 정책이 `MAPSReporting=0`, `SubmitSamplesConsent=2`(전송 안 함)임을 확인한 경우에만 Defender를 호출합니다. 확인할 수 없거나 기본 클라우드 설정이 적용되어 있으면 **사용 불가**로 알리고 설치된 로컬 ClamAV 사용을 안내합니다. 이 기능을 위해 Windows 보호 기능을 끄거나 낮추는 것은 권장하지 않습니다.

ClamAV를 우선 사용하며, Windows에서는 조건을 만족하는 Defender를 대안으로 사용합니다. Defender 검사에는 `-DisableRemediation`을 전달해 이 프로그램이 자동으로 삭제·치료하지 않도록 합니다. 별도로 켜져 있는 운영체제의 실시간 백신은 자체 정책에 따라 원본이나 임시 복사본을 격리할 수 있습니다. 이 프로그램은 격리 파일을 복원하지 않습니다.

## 제거

```sh
python3 native/install.py --uninstall
# Windows: py -3 native/install.py --uninstall
# 설치 때 다른 브라우저를 선택했다면 같은 --browser 값을 추가
```

고정된 동반 프로그램 파일과 선택한 브라우저 등록만 제거합니다. 백신·Python·다운로드 파일은 삭제하지 않습니다. 두 브라우저를 함께 설치했다면 `--browser both`로 제거하세요.

## 검사 범위와 한계

- 검사할 파일은 확장의 다운로드 기록에서 확인된 절대 경로만 전달합니다. 웹페이지가 임의 파일 경로를 지정하는 인터페이스는 제공하지 않습니다.
- 호스트는 일반 파일만 받고 심볼릭 링크·정션·reparse point와 상위 경로 이동을 거부합니다. 최대 파일 크기는 **2 GiB − 1바이트**, 검사 명령의 제한 시간은 **120초**입니다. 더 큰 파일·불완전한 검사·엔진 오류는 검사 실패로 남습니다.
- 사용자 전용 임시 폴더의 복사본을 검사하고 종료 시 정리합니다. 원본의 크기·식별자·변경 시각과 SHA-256을 검사 전후 확인합니다. 파일이 바뀌면 안전 판정을 인정하지 않습니다. 임시 디스크 공간은 파일 크기와 추가 16 MiB 이상이 필요합니다.
- `clean`은 해당 백신이 해당 시점에 탐지하지 않았다는 뜻입니다. 최신 서명과 Chrome 기본 다운로드 보호를 함께 유지하세요. 새 악성코드·미디어 재생기 취약점의 완전한 차단을 보장하지 않습니다.
- 검사 결과로 파일을 자동 실행하지 않습니다. 파일 이름 변경·삭제·검역소 복원이나 Chrome의 위험 다운로드 허용을 백그라운드에서 실행하지 않습니다.

## Native messaging 계약

호스트 이름은 `com.myvideoapp.antivirus`이며 설치 시 지정한 `chrome-extension://<ID>/`만 연결할 수 있습니다. stdin/stdout에는 Chrome의 4바이트 little-endian 길이 + UTF-8 JSON 프레임만 씁니다. 최대 프레임은 64 KiB이며 stdout에 로그를 출력하지 않습니다.

```json
{"version":1,"action":"scan","requestId":"unique-request-id","path":"/absolute/download/video.mp4"}
```

응답은 같은 `requestId`, `version:1`, `status`(`clean`, `infected`, `unavailable`, `error`), `engine`을 포함합니다. `clean`/`infected`는 변경되지 않은 검사 대상의 64자리 소문자 `sha256`과 정수 `size`를 반드시 포함하며 탐지 시 `threats` 문자열 배열을 추가합니다. 실패 시 `message`가 원인을 설명하고 안전 판정을 내리지 않습니다. 요청 ID는 영문·숫자·`.`·`_`·`:`·`-`로 최대 128자입니다. 실행 가능한 요청은 `scan` 하나뿐이며 프로그램 실행·URL 다운로드·계정 정보 접근 명령은 없습니다.

개발 검사는 `python3 -m unittest discover -s native -p 'test_*.py' -v`로 실행합니다. 테스트는 무해한 고정 문자열과 가짜 백신 실행 파일로 입출력·실패·탐지 분기를 검사하며 실제 악성코드를 포함하지 않습니다.

실제 ClamAV 엔진을 설치한 개발 환경에서는 다음 통합 검사를 실행할 수 있습니다.

```sh
python3 -B native/test_clamav_integration.py \
  --clamav /absolute/path/to/clamscan \
  --video /absolute/path/to/clean-video.mp4 \
  --report /tmp/my-video-app-clamav-report.json
```

이 검사는 임시 전용 서명 데이터베이스를 만들고 실제 호스트 프로세스의 native messaging을 통해 정상 동영상, 무해한 탐지용 문자열, 잘못된 데이터베이스의 오류를 검사합니다. 외부 임시 위치의 표준 무해한 백신 테스트 파일은 `--eicar`로 선택적으로 전달할 수 있으며 원문을 출력하거나 저장소로 복사하지 않습니다. **공식 서명 데이터베이스의 최신성·악성코드 탐지 범위를 검증하는 검사는 아닙니다.** 이 개발용 데이터베이스·어댑터는 제품에 포함하지 않습니다. Windows Defender의 실제 운영체제 검사는 별도 Windows 환경에서 확인해야 합니다.
