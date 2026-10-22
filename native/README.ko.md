# My Video App 로컬 백신 연결

Chrome 확장은 운영체제 백신을 직접 실행할 수 없어 이 별도 동반 프로그램을 사용합니다. Python **3.11 이상**이 필요합니다. 동반 프로그램에는 외부 백신 없이도 실행하는 기본 정적 위험 신호 점검이 포함됩니다. 외부 백신 검사는 Windows 기본 Microsoft Defender 또는 Windows AMSI를 지원하는 활성 백신에 연결하며, Linux/macOS에서는 ClamAV가 필요합니다. 프로그램 자체는 파일·해시를 서버에 전송하지 않으며 사용자 계정에만 설치됩니다. 백신·Chrome의 기존 클라우드 보호·샘플 전송 정책은 그대로 적용됩니다. 관리자 권한을 요구하거나 브라우저·백신의 보호 설정을 바꾸지 않습니다.

## 설치

1. 확장을 설치한 후 `chrome://extensions`에서 **My Video App의 확장 ID**를 복사합니다. 설치 위치가 달라지면 ID가 바뀔 수 있습니다.
2. Windows 외부 백신 검사는 기본 Defender 또는 기존 백신을 그대로 사용합니다. Linux/macOS의 외부 백신 검사에는 ClamAV와 현재 서명 데이터베이스가 필요하며, Windows에서도 직접 선택하면 ClamAV를 사용할 수 있습니다. 기본 정적 점검에는 외부 백신이나 서명 데이터베이스가 필요하지 않습니다. ClamAV 서명 업데이트는 운영체제의 정상 업데이트 도구로 별도 관리합니다.
3. 전체 소스 ZIP을 풀고 해당 프로젝트 폴더에서 실행합니다. 별도 도우미 ZIP을 푼 경우에는 아래 `native/install.py`를 `install.py`로 바꾸세요. 아래 ID를 실제 ID로 바꾸세요.

```sh
# Linux / macOS
python3 native/install.py --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Windows (설치된 Python 3.11 이상)
py -3 native/install.py --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Chromium은 `--browser chromium`, 둘 다 등록하려면 `--browser both`를 추가합니다. ClamAV가 표준 설치 경로에 없다면 `--clamav /absolute/path/to/clamscan`(Windows는 `C:\...\clamscan.exe`)을 추가합니다. 임의 명령·추가 인수는 허용하지 않습니다. Python 실행 파일의 절대 경로가 기록되므로 Python을 옮기거나 삭제하면 다시 설치해야 합니다. Chrome의 조직 정책이 native messaging을 차단하면 관리자가 허용해야 하며 이 프로그램은 정책을 우회하지 않습니다.

확장을 새로고침한 후 앱에서 **로컬 백신 연결**을 누르고 선택 권한을 허용하면 다음 완료된 다운로드부터 자동 검사가 작동합니다. 동반 프로그램이 있고 기본 정적 점검을 사용할 수 있으면 외부 백신이 없어도 기본 점검과 다시 검사를 할 수 있습니다. 외부 백신이 없거나 검사 실패·시간 초과가 발생하면 외부 백신 결과는 **검사하지 못함**으로 남기며 기본 점검 결과와 따로 표시합니다. 이를 안전 판정으로 바꾸지 않습니다. 검사 완료 전에는 파일을 열지 마세요. 확장이 완료된 다운로드의 경로를 받은 뒤 검사하므로 Chrome의 다운로드 폴더에는 파일이 먼저 생성됩니다.

### Windows 기본 백신과 다른 백신

기본 `--scanner auto`는 Windows 보안 센터의 활성 보호 제품을 확인합니다. 타사 제품이 없으면 Defender를 선택하고, 타사 제품이 있으면 일치하는 Windows AMSI 공급자 등록을 확인해 연결합니다. 지원되지 않는 제품·불명확한 상태는 미검사로 남깁니다. 조회된 실행 경로는 실행하지 않습니다. Windows 보안 센터 조회 실패 시 Defender의 활성 Normal 모드를 직접 확인하는 경우에만 대안으로 사용합니다.

AMSI는 실제 응답 공급자 이름을 반환하지 않으므로 결과 엔진은 Windows AMSI로 표시합니다. 보안 센터의 제품명과 실제 결과 공급자가 같다고 보장하지 않습니다. 파일 전체 버퍼 검사 128MiB 한도가 있으며 분할 검사로 우회하지 않습니다. Defender/ClamAV는 2GiB−1바이트까지 지원합니다.

`--scanner defender` 또는 `--scanner clamav`로 직접 선택할 수 있습니다. `--clamav` 경로 지정도 명시적 ClamAV 선택입니다. 기존 ClamAV 필수 안내와 Defender의 오프라인 정책 요구는 제거했습니다. Defender/기존 백신의 보호·클라우드·샘플 전송 설정을 변경하지 않으며, 백신이 기존 정책에 따라 전송할 수 있습니다.

Defender 검사에는 `-DisableRemediation`을 전달해 앱의 검사 명령이 자동 치료하지 않도록 합니다. 별도로 켜져 있는 실시간 백신은 자체 정책에 따라 원본이나 임시 복사본을 격리할 수 있으며 프로그램은 이를 복원하지 않습니다.

## 제거

```sh
python3 native/install.py --uninstall
# Windows: py -3 native/install.py --uninstall
# 설치 때 다른 브라우저를 선택했다면 같은 --browser 값을 추가
```

고정된 동반 프로그램 파일과 선택한 브라우저 등록만 제거합니다. 백신·Python·다운로드 파일은 삭제하지 않습니다. 두 브라우저를 함께 설치했다면 `--browser both`로 제거하세요.

## 검사 범위와 한계

- 검사할 파일은 확장의 다운로드 기록에서 확인된 절대 경로만 전달합니다. 웹페이지가 임의 파일 경로를 지정하는 인터페이스는 제공하지 않습니다.
- 호스트는 일반 파일만 받고 심볼릭 링크·정션·reparse point와 상위 경로 이동을 거부합니다. Defender/ClamAV 최대 파일 크기는 **2 GiB − 1바이트**, AMSI는 **128 MiB**, 검사 명령의 제한 시간은 **120초**입니다. 더 큰 파일·불완전한 검사·엔진 오류는 검사 실패로 남습니다.
- 사용자 전용 임시 폴더의 복사본을 검사하고 종료 시 정리합니다. 원본의 크기·식별자·변경 시각과 SHA-256을 검사 전후 확인합니다. 파일이 바뀌면 안전 판정을 인정하지 않습니다. 임시 디스크 공간은 파일 크기와 추가 16 MiB 이상이 필요합니다.
- `clean`은 해당 백신이 해당 시점에 탐지하지 않았다는 뜻입니다. 최신 서명과 Chrome 기본 다운로드 보호를 함께 유지하세요. 새 악성코드·미디어 재생기 취약점의 완전한 차단을 보장하지 않습니다.
- 기본 정적 점검은 무해한 표준 백신 시험 마커, 검증된 실행 파일 구조, 미디어로 위장한 스크립트·문서·압축 파일, 미디어 뒤에 붙은 ZIP 같은 제한된 위험 신호만 확인합니다. 파일 실행·압축 해제·서명 다운로드 없이 읽기 크기와 탐색 횟수를 제한합니다. `no-signals`는 이 규칙에서 신호를 찾지 못했다는 뜻이며 외부 백신의 `clean`이나 안전 보장이 아닙니다. 점검 한도·지원 형식·읽기 오류가 있으면 불완전한 점검으로 남깁니다.
- 검사 결과로 파일을 자동 실행하지 않습니다. 파일 이름 변경·삭제·검역소 복원이나 Chrome의 위험 다운로드 허용을 백그라운드에서 실행하지 않습니다.

## Native messaging 계약

호스트 이름은 `com.myvideoapp.antivirus`이며 설치 시 지정한 `chrome-extension://<ID>/`만 연결할 수 있습니다. stdin/stdout에는 Chrome의 4바이트 little-endian 길이 + UTF-8 JSON 프레임만 씁니다. 최대 프레임은 64 KiB이며 stdout에 로그를 출력하지 않습니다.

```json
{"version":1,"action":"scan","requestId":"unique-request-id","path":"/absolute/download/video.mp4"}
```

응답은 같은 `requestId`, `version:1`, `status`(`clean`, `infected`, `unavailable`, `error`), `engine`을 포함합니다. `clean`/`infected`는 변경되지 않은 검사 대상의 64자리 소문자 `sha256`과 정수 `size`를 반드시 포함하며 탐지 시 `threats` 문자열 배열을 추가합니다. 실패 시 `message`가 원인을 설명하고 안전 판정을 내리지 않습니다. 요청 ID는 영문·숫자·`.`·`_`·`:`·`-`로 최대 128자입니다. 지원 요청은 파일 검사 `scan`과 경로 없는 연결 확인 `status`뿐이며 프로그램 실행·URL 다운로드·계정 정보 접근 명령은 없습니다.

기본 정적 점검을 마치고 현재 파일의 바이트가 그대로인지 확인한 응답에는 `internalScan`과 그 바이트의 `sha256`·`size`가 붙습니다. 외부 백신이 `unavailable`/`error`여도 이 기본 점검 결과는 제공할 수 있으며 외부 백신 상태는 유지합니다. 파일이 검사 중 바뀌면 해시와 기본 점검 결과를 인정하지 않습니다.

개발 검사는 `python3 -m unittest discover -s native -p 'test_*.py' -v`로 실행합니다. 테스트는 무해한 고정 문자열과 가짜 백신 실행 파일로 입출력·실패·탐지 분기를 검사하며 실제 악성코드를 포함하지 않습니다.

실제 ClamAV 엔진을 설치한 개발 환경에서는 다음 통합 검사를 실행할 수 있습니다.

```sh
python3 -B native/test_clamav_integration.py \
  --clamav /absolute/path/to/clamscan \
  --video /absolute/path/to/clean-video.mp4 \
  --report /tmp/my-video-app-clamav-report.json
```

이 검사는 임시 전용 서명 데이터베이스를 만들고 실제 호스트 프로세스의 native messaging을 통해 정상 동영상, 무해한 탐지용 문자열, 잘못된 데이터베이스의 오류를 검사합니다. 외부 임시 위치의 표준 무해한 백신 테스트 파일은 `--eicar`로 선택적으로 전달할 수 있으며 원문을 출력하거나 저장소로 복사하지 않습니다. **공식 서명 데이터베이스의 최신성·악성코드 탐지 범위를 검증하는 검사는 아닙니다.** 이 개발용 데이터베이스·어댑터는 제품에 포함하지 않습니다. Windows Defender의 실제 운영체제 검사는 별도 Windows 환경에서 확인해야 합니다.

## 도우미 연결 상태 확인 (1.6.0)

최신 도우미는 경로 없는 `{"version":1,"action":"status","requestId":"unique-request-id"}`도 지원합니다. 응답 상태는 `ready`, `unavailable`, `error`이며 선택된 `engine`, 선택 판단에 사용된 `products`, 설명을 반환할 수 있습니다. 사용자 파일을 읽거나 검사하지 않습니다. `ready`는 도우미와 외부 검사기 실행·초기화 준비 상태이며 파일의 위협 미탐지나 서명 DB 검증 결과가 아닙니다. 기본 정적 점검 모듈을 정상적으로 불러오고 인터페이스를 확인한 경우에만 `internalAvailable:true`를 추가합니다. 외부 백신이 없거나 설정에 오류가 있어도 이 값으로 기본 점검만 가능한지 확인할 수 있으며 외부 백신의 상태는 바뀌지 않습니다. 잘못된 요청이나 누락·손상된 기본 점검 모듈에는 이 값을 추가하지 않습니다. 앱의 백신 연결 버튼이 이 요청을 실제로 수행합니다. 기존 `scan` 계약과 파일 판정은 유지합니다.

1.7.0의 ClamAV 검사는 암호화된 내부 파일을 읽지 못하면 미검사(`error`)로 반환하며, 대소문자가 섞인 엔진 경고·오류도 검사 실패로 처리합니다. 암호화와 실제 위협이 함께 보고되면 위협 탐지를 유지합니다. 최신 도우미 ZIP으로 설치 명령을 다시 실행해 업데이트하세요.
