# GiTex

[English](README.md) | 한국어

VS Code에서 LaTeX 논문을 편집하면서 줄별 검토 의견을 Git으로 공유하는 확장입니다. LaTeX Workshop 등 기존 편집·컴파일·PDF 미리보기 환경과 함께 사용합니다.

## 첫 버전에서 가능한 작업

- 기존 Git 저장소 열기, 복제, 충돌이 없는 현재 폴더에 저장소 적용
- 주석 공유용 remote 선택·추가
- `.tex`, `.bib`, `.sty`, `.cls`, `.ltx`의 한 줄 또는 여러 줄에 주석 작성
- 답글 작성 및 Explorer·리뷰 패널의 해결 체크박스; 해결된 주석은 Explorer에 남기고 본문에서 숨기기
- 주석과 답글 편집, 원문 및 모든 편집 이력 보존
- 새 주석·답글·편집 저장 직후 한 번 자동 pull + push; 기본 활성화, 설정으로 변경 가능
- Explorer의 **GiTex Comments**와 VS Code **Comments** 패널에서 주석 확인
- 문자열 유사도와 주변 문맥으로 작은 본문 수정·공백 변경·줄바꿈·이동 추적
- 주석·답글 저장 시 현재 본문으로 추적 기준 갱신 및 이전 기준 이력 보존
- 리뷰 탭 하나를 재사용하고 스레드 전환 시 작성 중인 편집·답글 초안 보존
- 신뢰할 만한 단일 위치를 찾을 수 없을 때 **Outdated** 표시와 저장된 발췌문 보존
- 오프라인 주석 저장 및 중앙 bare 저장소를 통한 여러 사용자의 주석 동기화

논문 커밋·push/pull·병합은 VS Code의 **Source Control**을 사용합니다. **Sync Comments**와 저장 직후 자동 동기화는 모두 주석을 가져오고 공유합니다. 두 동작 모두 편집 중인 파일, 현재 브랜치, 스테이징 영역을 변경하지 않습니다.

## 설치와 사용

필요한 환경은 VS Code 1.90 이상, Git, 로컬 논문 저장소입니다. LaTeX 컴파일에는 기존에 사용하던 LaTeX 확장과 TeX 배포판이 필요합니다.

1. VS Code 명령 팔레트에서 **Extensions: Install from VSIX…**를 실행하고 `gitex-0.4.0.vsix`를 선택합니다.
2. 논문의 로컬 Git 저장소 폴더를 엽니다. 새로 복제하려면 **GiTex: Clone Repository**, 이미 열린 폴더에 적용하려면 **GiTex: Apply Repository to Current Folder**를 실행합니다.
3. Git 작성자 이름과 이메일이 설정되어 있어야 합니다.

   ```sh
   git config user.name "Your Name"
   git config user.email "you@example.com"
   ```

4. 기본 remote는 `origin`입니다. 다른 remote를 사용하거나 추가하려면 **GiTex: Connect Repository**를 실행합니다.
5. 논문 파일에서 줄을 선택한 뒤 **Ctrl+Shift+/** (macOS: **Cmd+Shift+/**)를 누르면 주석 입력창이 열립니다. 선택 영역이 없으면 커서가 있는 줄에 작성합니다. 우클릭 → **GiTex: Add Line Comment** 또는 편집기 왼쪽 주석 버튼으로도 작성할 수 있습니다.
6. 주석·답글·편집을 저장하면 백그라운드에서 자동 동기화합니다. 받기만 하려면 **GiTex: Fetch Comments**, 수동으로 받고 공유하려면 **GiTex: Sync Comments**를 실행합니다.
7. 논문 본문 변경은 Source Control에서 커밋하고 동기화합니다.

파일이 디스크에 존재하면 저장하지 않은 편집 내용에도 주석을 달 수 있습니다. 다른 사용자가 그 문장을 아직 받지 않았다면 해당 주석은 Outdated로 표시되고, 원래 발췌문을 확인할 수 있습니다. 줄 선택은 전체 줄 단위로 저장됩니다.

단축키는 편집 가능한 로컬 `.tex`, `.bib`, `.sty`, `.cls`, `.ltx` 파일의 본문에 포커스가 있을 때 동작합니다. 단축키를 바꾸려면 VS Code의 Keyboard Shortcuts에서 `GiTex: Add Line Comment`를 검색하세요.

네트워크 인증은 Git의 SSH 에이전트나 HTTPS 자격 증명 도우미를 사용합니다. 먼저 같은 환경의 터미널에서 `git ls-remote origin`이 성공하는지 확인하면 됩니다. 원격 서버에는 `gitex-comments` 브랜치를 읽고 쓸 수 있는 권한이 필요합니다.

## 주석 편집과 이력 보기

인라인 주석이나 답글에서 **Edit Comment**를 선택하고 내용을 변경한 뒤 **Save Edit**로 저장합니다. **Cancel Edit**는 입력 중인 초안을 취소합니다. 최신 저장 내용에는 **Edited** 표시가 붙습니다. **View Edit History**는 원문부터 모든 편집 내용과 각 버전의 편집자·시간을 읽기 전용 문서로 보여줍니다.

인라인 저장에 실패하면 VS Code가 입력창을 닫더라도 초안을 복구할 수 있도록, GiTex가 리뷰 패널을 열어 입력 중이던 내용을 그대로 표시합니다.

**GiTex Comments**에서 스레드를 클릭하거나 인라인 스레드의 **Open GiTex Review**를 선택하면 리뷰 패널이 열립니다. 다른 스레드를 선택하면 같은 탭의 내용을 교체하며, 탭을 닫지 않고 돌아오면 해당 스레드의 편집·답글 초안과 펼침 상태가 복원됩니다. 이 패널에서 편집, 답글 작성, **History** 펼치기가 가능합니다. **Open source / saved excerpt**로 해당 문장이나 원래 발췌문을 열 수 있습니다. 주석 삭제 기능은 제공하지 않습니다.

편집 내용은 새 불변 이벤트로 로컬에 저장한 뒤, 설정이 켜져 있으면 자동 동기화합니다. **Sync Comments**로 수동 공유할 수도 있습니다. 편집 중 원격 변경을 받아도 입력 중인 초안은 유지됩니다. 오래된 버전을 기준으로 저장하려 하면 거절되므로 이력을 확인하고 편집을 취소한 뒤 최신 버전을 다시 편집하세요. 오프라인에서 동시에 편집한 경우 양쪽 버전이 모두 이력에 남고, 논리 시계와 이벤트 ID로 표시할 버전을 결정합니다. 이전 버전은 편집 이벤트를 읽을 수 없으므로 편집 내용을 공유하기 전에 협업자 모두 GiTex 0.2.0 이상으로 업데이트해야 합니다. 기존 주석은 0.4.0에서도 읽을 수 있습니다. 갱신된 위치 추적 기준을 함께 사용하려면 협업자 모두 0.4.0으로 업데이트하세요.

## 해결 체크박스

리뷰 패널의 **Resolved**, 또는 **GiTex Comments**의 스레드 옆 체크박스를 체크하면 LaTeX 편집기에서 해당 코멘트가 사라집니다. Explorer에는 해결 상태와 이력을 유지하며 계속 열람할 수 있습니다. 체크를 해제하면 위치를 찾을 수 있는 코멘트가 본문에 다시 나타납니다. 기존 인라인 **Resolve Thread**·**Reopen Thread**도 같은 상태를 변경합니다.

인라인 코멘트를 편집하다 해결해도 초안은 리뷰 패널에서 복구할 수 있습니다. 이전 `gitex.showResolved` 설정은 폐기 예정이며 더 이상 필터로 사용하지 않습니다. 해결된 코멘트는 항상 Explorer에 남고 본문에서는 숨깁니다. 해결/다시 열기는 로컬에 저장하고, 다음 코멘트 저장 또는 수동 **Sync Comments** 때 공유합니다. 저장 직후에만 자동 동기화하는 기존 규칙은 유지합니다.

## 본문 수정에 따른 위치 추적

먼저 원문과 주변 문맥의 정확한 일치를 찾습니다. 그것만으로 위치를 정하기 어려우면 공백을 정규화하고 줄 수가 다른 범위도 후보로 비교하여, 문자 편집 거리와 주변 문맥으로 위치를 찾습니다. 따라서 작은 단어 변경이나 문단 줄바꿈 후에도 코멘트를 유지할 수 있습니다. 근사 일치에는 본문과 Explorer에 **Similar text**를 표시하며, 리뷰 패널에는 문자열 유사도도 표시합니다.

일반 문장은 문맥이 뒷받침되면 최소 74%, 그렇지 않으면 86%의 문자열 유사도를 요구합니다. 짧은 문장은 더 엄격하게 판별합니다. 비슷한 후보가 여러 곳이면 예전 줄 번호와 가깝다는 이유만으로 붙이지 않습니다. 크게 바뀌거나 삭제된 문장, 구분하기 어려운 후보, 연산 제한을 넘는 경우에는 **Outdated**로 남깁니다. 의미를 이해하는 매칭이 아닌 문자열 비교입니다.

연결된 스레드의 코멘트를 편집 저장하거나 답글을 저장하면, 현재 매칭된 본문·주변 문맥·문서 해시를 새 추적 기준으로 기록합니다. 저장하지 않은 본문 편집도 반영합니다. 이후에는 이 새 기준에서 추적합니다. 코멘트 열기·본문 타이핑·해결 체크·편집 취소만으로 기준을 바꾸지는 않습니다. 위치가 불확실하면 코멘트를 저장해도 기존 기준을 유지합니다.

리뷰 패널의 **Tracking history**에서 최초 본문과 갱신된 추적 기준, 작성자·시간을 확인할 수 있습니다. 기준 갱신은 해당 코멘트 편집·답글과 같은 불변 이벤트에 기록하여 함께 동기화합니다. 동시에 갱신해도 양쪽 기준을 모두 보존하고 일관된 순서로 현재 기준을 선택합니다. 저장 실패나 오래된 편집 거절 시에는 기준이 바뀌지 않습니다.

## 저장 직후 자동 동기화

`gitex.autoSyncOnSave`의 기본값은 `true`입니다. 새 주석·답글·편집을 성공적으로 저장하면 로컬 내용을 화면에 먼저 반영하고, 백그라운드에서 한 번 **pull + push**합니다. 열기·클릭·펼치기·포커스 이동·이력 보기·편집 시작/취소·해결/다시 열기는 원격 요청을 발생시키지 않습니다. **Refresh Comments**는 로컬 데이터만 다시 읽습니다. 주기적인 polling은 없습니다.

동기화할 때는 이전에 로컬에 저장한 주석 이벤트와 해결/다시 열기 변경도 함께 공유합니다. 논문 브랜치·작업 파일·스테이징 영역은 변경하지 않습니다. 원격의 최신 편집을 이미 받은 상태에서 오래된 초안을 저장하면 거절합니다. 아직 받지 못한 상태에서 저장했다면 동시 편집으로 처리하여, 동기화 후 두 버전을 모두 이력에 보존합니다.

네트워크 연결이 실패해도 코멘트는 로컬에 저장됩니다. 리뷰 패널과 상태 표시줄에 동기화 대기 상태를 표시하고 GiTex Output에 오류를 남깁니다. 다음 저장이나 **Sync Comments**로 다시 시도할 수 있습니다.

VS Code 설정의 **GiTex: Auto Sync On Save**를 끄거나 다음 설정을 추가하세요.

```json
{
  "gitex.autoSyncOnSave": false
}
```

이 설정을 꺼도 **GiTex: Fetch Comments**와 **GiTex: Sync Comments**는 사용할 수 있습니다. 이전 `gitex.autoPullOnInteraction` 설정은 폐기 예정이며, 상호작용 시 가져오기는 더 이상 수행하지 않습니다. 기존에 명시적으로 `false`로 설정했다면 새 `gitex.autoSyncOnSave`를 직접 설정할 때까지 자동 동기화를 끈 상태로 유지합니다.

## 현재 폴더에 저장소 적용

대상 폴더를 연 뒤 **GiTex: Apply Repository to Current Folder**를 실행하고 SSH/HTTPS URL 또는 로컬 bare 저장소 경로를 입력합니다. 여러 폴더를 연 경우 활성 편집기가 속한 폴더를 사용하거나 대상 폴더를 선택합니다. 상대 로컬 경로는 대상 폴더를 기준으로 해석합니다.

현재 폴더 바로 아래에 `.git`과 원격 기본 브랜치에서 가져온 최신 파일을 만들고, `origin` 및 브랜치 추적을 설정합니다. 프로젝트 하위 폴더를 하나 더 만들지 않습니다. 이후 논문 변경은 Source Control로 처리하며, 기존 리뷰는 **Fetch Comments**로 받을 수 있습니다.

원격 저장소를 임시 작업 폴더에 먼저 받아 충돌을 검사합니다. 관계없는 기존 파일은 유지하고, 같은 디렉터리도 내부 경로가 겹치지 않으면 허용합니다. 가져올 파일과 같은 경로가 이미 있으면 내용이 같더라도 중단합니다. 파일/디렉터리 충돌, 심볼릭 링크를 통과하는 경로, 기존 `.git`, 다른 Git 저장소 내부 폴더, 저장하지 않은 편집 파일이 있어도 중단합니다. 충돌하는 내용은 먼저 저장하거나 다른 위치로 옮겨야 하며, 이 명령은 이를 병합하거나 덮어쓰지 않습니다.

현재 이 명령은 커밋이 있는 기본 논문 브랜치와 일반 파일을 지원합니다. 심볼릭 링크나 서브모듈이 있는 저장소는 **Clone Repository**를 사용하세요. 파일시스템이 하드 링크를 지원해야 하며, 배타적 파일 생성으로 적용 도중 새로 생긴 파일도 덮어쓰지 않습니다. 적용에 실패하면 추가한 파일을 되돌리되, 사용자가 동시에 변경한 파일은 보존합니다.

## 두 사용자로 체험하기

아래는 로컬 임시 폴더에서 사용할 예시입니다. 새 폴더에서 실행하세요.

```sh
git init --bare --initial-branch=main paper.git
git clone paper.git alice
cd alice
git config user.name Alice
git config user.email alice@example.test
printf '\\documentclass{article}\n\\begin{document}\nHello, GiTex.\n\\end{document}\n' > main.tex
git add main.tex
git commit -m "Initial paper"
git push -u origin main
cd ..
git clone paper.git bob
git -C bob config user.name Bob
git -C bob config user.email bob@example.test
```

`alice`와 `bob`을 각각 별도 VS Code 창으로 열고 GiTex를 설치합니다. Alice가 주석을 작성한 뒤 Sync Comments를 실행하고, Bob도 Sync Comments를 실행하면 같은 주석이 나타납니다. 양쪽에서 오프라인으로 답글을 작성한 뒤 동기화해도 답글들이 함께 보존됩니다. 서버에서는 위 `paper.git`을 SSH 등으로 제공하면 됩니다.

## 데이터 저장과 동시 작업

| 위치 | 용도 |
| --- | --- |
| 일반 논문 브랜치 | `.tex`, `.bib`, 그림 등 논문 파일 |
| 로컬 `refs/gitex/comments` | 아직 공유하지 않은 주석을 포함한 로컬 주석 이력 |
| 원격 `refs/heads/gitex-comments` | 공동 주석 이력; GiTex 전용으로 예약 |

주석 생성, 답글, 편집, 상태 변경은 UUID가 있는 불변 이벤트로 저장합니다. 동기화는 양쪽 이벤트를 합친 다음 일반 push를 수행합니다. 다른 사용자가 먼저 push하면 다시 가져와 합치고 재시도하며, force push는 사용하지 않습니다. 같은 로컬 저장소를 여러 창에서 수정할 때는 Git ref의 예상 이전 값을 검사해 덮어쓰기를 방지합니다.

해결·다시 열기가 동시에 발생하면 논리 시계와 이벤트 ID 순서로 일관된 최종 상태를 정합니다. 두 상태 변경의 이력은 모두 남습니다. 주석의 작성자 정보는 Git 설정에서 가져오며, 별도의 사용자 인증이나 서명 검증은 제공하지 않습니다.

각 주석은 기준 커밋, 로컬 문서 해시, 파일 경로, 줄 범위, 원문과 앞뒤 문맥을 기록합니다. 기준 커밋은 작성 시 HEAD이며, 저장하지 않은 변경이 있으면 주석 원문은 그 커밋의 파일과 다를 수 있습니다. 최신 추적 기준으로 충분히 유사하고 구분 가능한 위치를 찾지 못하면, 임의로 연결하지 않고 저장된 발췌문을 보존합니다. 최초 본문은 Tracking history에 남습니다.

주석 이력에는 발췌문과 작성자 이메일도 포함됩니다. 일반 논문 브랜치만 백업하면 로컬의 미공유 주석은 포함되지 않으므로, 공유할 주석은 Sync Comments로 올리거나 전체 Git 저장소를 백업하세요. `gitex-comments`를 논문 브랜치에 병합하거나 편집용 브랜치로 사용하지 마세요.

## 개발과 검증

개발·패키징에는 Node.js 22 이상과 npm을 사용합니다. 아래 Makefile 명령에는 GNU Make도 필요합니다. 런타임 npm 의존성은 없습니다.

```sh
make install
make package
```

프로젝트 루트에서 실행하면 현재 버전의 VSIX 파일(예: `gitex-0.4.0.vsix`)이 생성됩니다. `make` 또는 `make help`로 사용 가능한 명령을 확인할 수 있습니다.

| Make 명령 | 실행하는 작업 |
| --- | --- |
| `make install` | `npm ci`로 개발 의존성 설치; 최초 실행 및 의존성 변경 후 사용 |
| `make build` | `npm run compile`로 TypeScript 컴파일 |
| `make watch` | `npm run watch`로 파일 변경 시 자동 컴파일; Ctrl+C로 종료 |
| `make test` | `npm test`로 컴파일 및 핵심 테스트 실행 |
| `make test-extension` | `npm run test:extension`으로 실제 VS Code에서 테스트 |
| `make package` | `npm run package`로 컴파일 및 VSIX 생성 |
| `make clean` | `out/`과 루트의 `gitex-*.vsix` 삭제; 의존성과 VS Code 테스트 캐시는 유지 |

Make는 기존 npm 스크립트를 호출합니다. Make 없이도 표의 npm 명령을 직접 실행할 수 있습니다.

이 프로젝트 폴더를 VS Code에서 열고 **F5 → Run GiTex Extension**을 실행하면 별도 Extension Development Host가 열립니다. 그 창에서 논문 저장소 폴더를 여세요.

```sh
make test
make test-extension
```

`make test-extension`은 공식 테스트 도구로 VS Code 1.90.2를 다운로드하고 임시 저장소·프로필에서 실제 확장을 실행합니다. Linux CI에서는 X 서버 또는 `xvfb-run -a make test-extension`이 필요합니다. `GITEX_VSCODE_VERSION=stable make test-extension`으로 현재 안정 버전에서도 실행할 수 있습니다. `make package`는 공식 `vsce` 도구를 내려받아 VSIX 파일을 만듭니다. Marketplace에는 게시하지 않습니다.

핵심 테스트는 동시 push·편집, 전체 편집 이력, 오래된 초안 검출, push 없는 pull, 로컬 다중 창 업데이트, 오프라인 보존, 서버 거절, 메타데이터 브랜치 충돌, 작업 트리·index 보존, 줄 이동·작은 수정·줄바꿈·삭제·중복 문장 처리와 동시 추적 기준 갱신을 확인합니다. 확장 호스트 테스트에서는 Playwright로 테스트 인스턴스의 로컬 디버깅 포트에 연결해 리뷰 패널의 실제 클릭·펼침에서 원격 요청이 없는지, 저장 후 자동 pull/push, 설정 비활성화, 초안 보존, 해결 상태별 표시, 단일 리뷰 탭 전환, 추적 기준 갱신, 저장소 적용 시 저장하지 않은 편집 내용 보호도 검증합니다. 저장소 적용 테스트는 경로 충돌, 동시 파일 생성, 실패 시 되돌리기와 기존 파일 보존을 확인합니다.

## 현재 범위

- 주석은 기본적으로 저장 직후 자동 동기화하며, 수동 명령으로도 동기화할 수 있습니다. 실시간 공동 타이핑이나 자동 서버 알림은 없습니다.
- 주석 UI는 LaTeX 소스에 표시됩니다. PDF 위 주석, 문장 단위 의미 분석, LaTeX 컴파일 검증은 아직 없습니다.
- 파일 이름이 바뀌면 주석을 자동으로 새 파일로 옮기지 않고 Outdated로 표시합니다. 수정된 본문의 유사도가 부족하거나 후보를 구분하기 어려울 때도 수동 검토가 필요합니다.
- 주석 삭제와 세부 사용자 권한은 제공하지 않습니다. 저장소 쓰기 권한을 가진 사용자는 편집·답글·상태 변경을 공유할 수 있습니다. 원래 작성자와 각 버전의 편집자를 구분해 기록합니다.
- 여러 workspace 폴더를 지원하며 각 폴더에서 발견한 Git 저장소를 사용합니다. 중첩 저장소는 별도 workspace 폴더로 열어야 합니다.
- 주석 이벤트를 메모리에서 합치는 초기 구현이며 Git 명령마다 수집하는 표준 출력과 오류 출력의 합계를 32 MiB로 제한합니다. 대규모 이력 최적화는 후속 작업입니다.
- 서버가 병합을 승인·실행하는 워크플로는 아직 없으며, 논문 병합은 기존 Git 기능으로 수행합니다.

기반 API: [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Git update-ref](https://git-scm.com/docs/git-update-ref), [VSIX 패키징](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
