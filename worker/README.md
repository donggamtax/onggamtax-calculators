# 직원 전용 법령 검색 설정 (taxdg.com/staff/)

직원 화면(`staff/`)은 GitHub Pages에 올라가고, 비밀번호 확인·법제처 조회·질문 내역 저장은
Cloudflare Workers 무료 요금제의 작은 서버(`worker/`)가 맡습니다. 비밀번호와 법제처 인증값은
코드에 넣지 않고 GitHub 비밀 값으로만 보관합니다.

## 처음 한 번만 하는 설정

1. **법제처 Open API 인증값(OC)**: open.law.go.kr 로그인 → 마이페이지 → Open API 신청 내역에서 확인합니다.
   신청 시 쓴 이메일의 @ 앞부분인 경우가 많습니다. 법령, 판례, 법령해석례, 조세심판원 특별행정심판례,
   중앙부처 1차 해석(국세청·기획재정부) 항목이 신청되어 있어야 합니다.
2. **Cloudflare 계정**(무료): dash.cloudflare.com 가입 후
   - 오른쪽 위 계정 메뉴 → Account ID 복사
   - My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 템플릿 선택 →
     권한에 Account · Workers KV Storage · Edit 가 있는지 확인 → 토큰 복사
3. **GitHub 비밀 값 넣기**: 이 저장소 Settings → Secrets and variables → Actions → New repository secret

   | 이름 | 값 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 2에서 만든 토큰 |
   | `CLOUDFLARE_ACCOUNT_ID` | 2에서 복사한 Account ID |
   | `LAW_OC` | 1의 인증값 |
   | `STAFF_PASSWORD` | 직원들이 쓸 비밀번호 |
   | `SESSION_SECRET` | 아무 긴 문자열(30자 이상, 외울 필요 없음) |

4. Actions 탭 → **Deploy staff API** → Run workflow. 끝나면 `staff/config.js`에 서버 주소가 자동으로 들어가고,
   잠시 뒤 https://taxdg.com/staff/ 에서 로그인할 수 있습니다.

비밀번호를 바꾸려면 `STAFF_PASSWORD` 값을 고친 뒤 4번을 다시 실행하면 됩니다.
기존에 로그인한 사람까지 바로 끊으려면 `SESSION_SECRET`도 함께 바꿉니다.
