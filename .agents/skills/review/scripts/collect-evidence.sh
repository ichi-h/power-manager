#!/usr/bin/env bash
# レビュー前の事実収集。diff・変更ファイル全文・検証ログを evidence.md にまとめる。
#
# 使い方:
#   .agents/skills/review/scripts/collect-evidence.sh <base-ref> [出力ディレクトリ]
#
# 例:
#   .agents/skills/review/scripts/collect-evidence.sh origin/main /tmp/review-t002
#
# 出力:
#   <out>/evidence.md   骨組み（3 章「検証済み事実」は人が埋める）
#   <out>/diff.patch    生の diff
#   <out>/files/        変更ファイル全文
#
# 注意: このスクリプトは事実を集めるだけで判断はしない。
#       「検証済み事実」節はオーケストレータが埋めること。

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <base-ref> [out-dir]" >&2
  exit 2
fi

BASE="$1"
OUT="${2:-/tmp/review-$(date +%Y%m%d-%H%M%S)}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HEAD_REF="$(git rev-parse --short HEAD)"
BASE_SHA="$(git rev-parse --short "$BASE")"
mkdir -p "$OUT/files"

DIFF_FILE="$OUT/diff.patch"
git diff --no-color "$BASE...HEAD" >"$DIFF_FILE"

# 変更ファイル一覧（追加/削除/変更を区別）
git diff --name-status "$BASE...HEAD" >"$OUT/name-status.txt"

# 統計
git diff --shortstat "$BASE...HEAD" >"$OUT/shortstat.txt"

# ステージされていない変更も拾う（作業ツリーに未コミットがある場合の取りこぼし防止）
if ! git diff --quiet || ! git diff --cached --quiet; then
  git diff --no-color >>"$DIFF_FILE"
  git diff --cached --no-color >>"$DIFF_FILE"
  echo "WARN: 未コミットの変更を diff に含めた。レビュー前にコミットを推奨" >&2
fi

# 各変更ファイルの全文を保存（削除ファイルは skip）
copied=0
while IFS=$'\t' read -r status path rest; do
  case "$status" in
    D*) continue ;;
  esac
  target="${rest:-$path}"
  [ -f "$target" ] || continue
  # ディレクトリ構造を保ってコピーする（ファイル名の変換はパスの衝突を招くため）
  dest="$OUT/files/$target"
  mkdir -p "$(dirname "$dest")"
  cp "$target" "$dest"
  copied=$((copied + 1))
done <"$OUT/name-status.txt"

# 検証ログ（失敗しても続行する）
CHECK_LOG="$OUT/check.log"
{
  echo "\$ npm run check"
  if command -v npm >/dev/null 2>&1; then
    npm run check 2>&1 || echo "(exit != 0)"
  else
    echo "(npm が無いため skip)"
  fi
} >"$CHECK_LOG" 2>&1

if [ -f scripts/smoke.mjs ] && command -v npm >/dev/null 2>&1; then
  {
    echo
    echo "\$ npm run smoke"
    npm run smoke 2>&1 || echo "(exit != 0)"
  } >>"$CHECK_LOG"
fi

TICKET="$(basename "$OUT" | sed 's/^review-//')"

{
  echo "# ${TICKET} レビュー対象 evidence"
  echo
  echo "生成: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "base: ${BASE} (${BASE_SHA})    head: ${HEAD_REF}"
  echo "作業ディレクトリ: ${REPO_ROOT}"
  echo
  echo "## 1. チケット / 受け入れ条件"
  echo
  echo "<!-- TODO: 要件定義・チケットの受け入れ条件を file:line 付きで転記する -->"
  echo
  echo "## 2. 差分"
  echo
  echo "$(cat "$OUT/shortstat.txt")"
  echo
  echo "対象ファイル一覧:"
  echo
  echo '| ファイル | 区分 |'
  echo '|---|---|'
  while IFS=$'\t' read -r status path rest; do
    case "$status" in
      A*) label="新規" ;;
      M*) label="変更" ;;
      D*) label="削除" ;;
      R*) label="リネーム" ;;
      *)  label="$status" ;;
    esac
    echo "| ${rest:-$path} | ${label} |"
  done <"$OUT/name-status.txt"
  echo
  echo '### diff'
  echo
  echo '```diff'
  cat "$DIFF_FILE"
  echo '```'
  echo
  echo '### 変更ファイル全文'
  echo
  while IFS= read -r f; do
    name="${f#"$OUT/files/"}"
    echo "#### ${name}"
    echo
    echo '```'
    cat "$f"
    echo '```'
    echo
  done < <(find "$OUT/files" -type f | sort)
  echo
  echo '## 3. 検証済み事実'
  echo
  echo '<!-- TODO: レビュアーはここを再検証しない。必ず file:line か実行ログの該当行を付ける -->'
  echo
  echo '### 3.1 実行して確認したこと'
  echo
  echo '```text'
  echo "$(tail -n 80 "$CHECK_LOG")"
  echo '```'
  echo
  echo '- <!-- TODO: 上のログから読み取れる事実 -->'
  echo
  echo '### 3.2 フレームワーク・依存の挙動（判断が分かれる点）'
  echo
  echo '- <!-- TODO: 例: lib の X は Y という挙動。根拠: node_modules/pkg/file:line -->'
  echo
  echo '### 3.3 仕様の該当箇所'
  echo
  echo '- <!-- TODO: docs/requirements.md:120-134: 該当要件の引用 -->'
  echo
  echo '### 3.4 対象外・既知の未対応'
  echo
  echo '- <!-- TODO: 今回のスコープ外・既存の未対応 -->'
  echo
  echo '## 4. レビュー時の注意'
  echo
  echo '- 上記に無い情報が必要な場合は、レポート末尾の「未確認事項」に 1 行で書くだけにする。'
  echo '- ここに書かれた事実を疑う場合も、実験のやり直しはしない。'
} >"$OUT/evidence.md"

echo "evidence を生成した: $OUT/evidence.md"
echo "  変更ファイル全文: $copied 件 -> $OUT/files/"
echo "  検証ログ: $CHECK_LOG"
echo
echo "次の手順: evidence.md の「## 1」「## 3」の TODO を埋めてからレビュアーへ渡す。"
