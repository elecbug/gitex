# GiTex

VS Code에서 LaTeX 논문을 편집하면서 줄별 검토 의견을 Git으로 공유하는 확장입니다. LaTeX Workshop 등 기존 편집·컴파일·PDF 미리보기 환경과 함께 사용합니다.

## 첫 버전에서 가능한 작업

- 기존 Git 저장소 열기, 복제, 주석 공유용 remote 선택·추가
- `.tex`, `.bib`, `.sty`, `.cls`, `.ltx`의 한 줄 또는 여러 줄에 주석 작성
- 편집기 안에서 답글 작성, 스레드 해결·다시 열기
- Explorer의 **GiTex Comments**와 VS Code **Comments** 패널에서 주석 확인
- 앞쪽 줄 삽입 등으로 이동한 원문에 주석 다시 연결
- 대상 문장이 바뀌거나 사라졌을 때 **Outdated** 표시와 원래 발췌문 보존
- 오프라인 주석 저장 및 중앙 bare 저장소를 통한 여러 사용자의 주석 동기화

논문 커밋·push/pull·병합은 VS Code의 **Source Control**을 사용합니다. **Sync Comments**는 주석만 동기화합니다. 편집 중인 파일, 현재 브랜치, 스테이징 영역은 변경하지 않습니다.

## 설치와 사용

필요한 환경은 VS Code 1.90 이상, Git, 로컬 논문 저장소입니다. LaTeX 컴파일에는 기존에 사용하던 LaTeX 확장과 TeX 배포판이 필요합니다.

1. VS Code 명령 팔레트에서 **Extensions: Install from VSIX…**를 실행하고 `gitex-0.1.0.vsix`를 선택합니다.
2. 논문의 로컬 Git 저장소 폴더를 엽니다. 새로 복제하려면 **GiTex: Clone Repository**를 실행합니다.
3. Git 작성자 이름과 이메일이 설정되어 있어야 합니다.

   ```sh
   git config user.name "Your Name"
   git config user.email "you@example.com"
   ```

4. 기본 remote는 `origin`입니다. 다른 remote를 사용하거나 추가하려면 **GiTex: Connect Repository**를 실행합니다.
5. 논문 파일에서 줄을 선택한 뒤 우클릭 → **GiTex: Add Line Comment**를 실행합니다. 편집기 왼쪽 주석 버튼으로도 작성할 수 있습니다.
6. **GiTex: Sync Comments** 또는 GiTex Comments 패널의 동기화 버튼으로 공유합니다. 다른 사용자도 같은 확장을 설치하고 이 명령을 실행하면 주석을 받습니다.
7. 논문 본문 변경은 Source Control에서 커밋하고 동기화합니다.

파일이 디스크에 존재하면 저장하지 않은 편집 내용에도 주석을 달 수 있습니다. 다른 사용자가 그 문장을 아직 받지 않았다면 해당 주석은 Outdated로 표시되고, 원래 발췌문을 확인할 수 있습니다. 줄 선택은 전체 줄 단위로 저장됩니다.

네트워크 인증은 Git의 SSH 에이전트나 HTTPS 자격 증명 도우미를 사용합니다. 먼저 같은 환경의 터미널에서 `git ls-remote origin`이 성공하는지 확인하면 됩니다. 원격 서버에는 `gitex-comments` 브랜치를 읽고 쓸 수 있는 권한이 필요합니다.

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

주석 생성, 답글, 상태 변경은 UUID가 있는 불변 이벤트로 저장합니다. 동기화는 양쪽 이벤트를 합친 다음 일반 push를 수행합니다. 다른 사용자가 먼저 push하면 다시 가져와 합치고 재시도하며, force push는 사용하지 않습니다. 같은 로컬 저장소를 여러 창에서 수정할 때는 Git ref의 예상 이전 값을 검사해 덮어쓰기를 방지합니다.

해결·다시 열기가 동시에 발생하면 논리 시계와 이벤트 ID 순서로 일관된 최종 상태를 정합니다. 두 상태 변경의 이력은 모두 남습니다. 주석의 작성자 정보는 Git 설정에서 가져오며, 별도의 사용자 인증이나 서명 검증은 제공하지 않습니다.

각 주석은 기준 커밋, 로컬 문서 해시, 파일 경로, 줄 범위, 원문과 앞뒤 문맥을 기록합니다. 기준 커밋은 작성 시 HEAD이며, 저장하지 않은 변경이 있으면 주석 원문은 그 커밋의 파일과 다를 수 있습니다. 원문이 수정·삭제되거나 여러 위치가 동일하게 일치하면 임의로 연결하지 않고 원본을 보존합니다.

주석 이력에는 발췌문과 작성자 이메일도 포함됩니다. 일반 논문 브랜치만 백업하면 로컬의 미공유 주석은 포함되지 않으므로, 공유할 주석은 Sync Comments로 올리거나 전체 Git 저장소를 백업하세요. `gitex-comments`를 논문 브랜치에 병합하거나 편집용 브랜치로 사용하지 마세요.

## 개발과 검증

개발·패키징에는 Node.js 22 이상과 npm을 권장합니다. 런타임 npm 의존성은 없습니다.

```sh
npm ci
npm test
```

이 프로젝트 폴더를 VS Code에서 열고 **F5 → Run GiTex Extension**을 실행하면 별도 Extension Development Host가 열립니다. 그 창에서 논문 저장소 폴더를 여세요.

```sh
npm run test:extension
npm run package
```

`test:extension`은 공식 테스트 도구로 VS Code 1.90.2를 다운로드하고 임시 저장소·프로필에서 실제 확장을 실행합니다. Linux CI에서는 X 서버 또는 `xvfb-run -a npm run test:extension`이 필요합니다. `GITEX_VSCODE_VERSION=stable`로 현재 안정 버전에서도 실행할 수 있습니다. `package`는 공식 `vsce` 도구를 내려받아 프로젝트 루트에 `gitex-0.1.0.vsix`를 만듭니다. Marketplace에는 게시하지 않습니다.

핵심 테스트는 두 사용자 간 동시 push, 로컬 다중 창 업데이트, 오프라인 보존, 서버 거절, 기존 메타데이터 브랜치 충돌, 작업 트리·index 보존, 줄 이동·삭제·중복 문장 처리를 확인합니다. 확장 호스트 테스트는 활성화, 실제 편집기 주석·답글·상태 변경, 위치 갱신, 원문 보기, 원격 동기화를 확인합니다.

## 현재 범위

- 동기화는 사용자가 명령을 실행할 때 수행합니다. 실시간 공동 타이핑이나 자동 서버 알림은 없습니다.
- 주석 UI는 LaTeX 소스에 표시됩니다. PDF 위 주석, 문장 단위 의미 분석, LaTeX 컴파일 검증은 아직 없습니다.
- 파일 이름이 바뀌면 주석을 자동으로 새 파일로 옮기지 않고 Outdated로 표시합니다. 원문 자체가 수정된 경우에도 수동 검토가 필요합니다.
- 주석 수정·삭제와 세부 사용자 권한은 아직 없습니다. 저장소 쓰기 권한을 가진 사용자는 답글과 상태 변경을 공유할 수 있습니다.
- 여러 workspace 폴더를 지원하며 각 폴더에서 발견한 Git 저장소를 사용합니다. 중첩 저장소는 별도 workspace 폴더로 열어야 합니다.
- 주석 이벤트를 메모리에서 합치는 초기 구현이며 Git 명령의 입출력 한도는 32 MiB입니다. 대규모 이력 최적화는 후속 작업입니다.
- 서버가 병합을 승인·실행하는 워크플로는 아직 없으며, 논문 병합은 기존 Git 기능으로 수행합니다.

기반 API: [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Git update-ref](https://git-scm.com/docs/git-update-ref), [VSIX 패키징](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
