# 작업 규칙

- 변경 사항은 커밋 후 **`main` 브랜치에 바로 합친다** (작업 브랜치에 푸시한 뒤 `main`에도 fast-forward로 푸시). 배포(GitHub Pages)는 `main` 기준.
- 앱 파일(`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`)을 바꾸면 `sw.js`의 `VERSION`을 올린다. 안 올리면 설치된 앱에 반영되지 않음.
- 혜택 데이터는 `js/data.js`에서만 수정한다. 출처는 각 카드사 상품설명서.
