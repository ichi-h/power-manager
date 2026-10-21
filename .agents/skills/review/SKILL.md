---
name: review
description: チケット実装のレビューを観点別に並列実行し、指摘を統合して改修する。レビューを依頼されたとき、複数観点でコードを検証するとき、または既存の並列レビューが遅い・冗長だと感じたときに使う。
---

# レビュー

観点別のレビューを並列実行し、指摘を統合して改修する。

## 原則

**探索は 1 回、判断は並列。**

レビューが遅くなるのは判断に時間がかかるからではない。各レビュアーが同じリポジトリを
ゼロから探索し直し、確認済みの事実を再検証し、レポートを推敲するからである。
所要時間はほぼ `turn 数 × 応答レイテンシ` で決まり、ツール実行時間は誤差でしかない。
したがって、事実収集はオーケストレータが 1 回だけ行い、レビュアーには判断だけをさせる。

## 手順

### 1. 対象を確定する

チケット ID、ブランチ、比較基準 `base`（マージ先 ref）、受け入れ条件を決める。
対象 diff が 800 行を超えるならレビューを分割する。1 回で見ない。

### 2. 事実パックを作る

オーケストレータ自身が実行する。レビュアーに探索させない。

```bash
.agents/skills/review/scripts/collect-evidence.sh <base-ref> /tmp/review-<ticket>
```

diff 全文・変更ファイル全文・`npm run check` / `npm run smoke` のログが `evidence.md` に入る。
そのあと `## 1` と `## 3` の TODO を自分で埋める。書式と書き方は
`references/evidence-template.md` に従う。

埋めるのは**レビュアーが再検証しがちなものだけ**:

- 実際に動かして確認した挙動（実行ログの該当行）
- 判断が割れるフレームワーク・依存の挙動（`node_modules/pkg/file:line` まで）
- 仕様書の該当行（`docs/requirements.md:120-134`）
- 対象外・既知の未対応の明示

**事実には必ず file:line を付ける。** これが無いとレビュアーは「念のため確認」を始め、
探索モードに落ちる。

### 3. 観点とモデルを決める

必要な観点だけ選ぶ。常にすべての観点を使用する必要はない。

| 観点 | 必要になる条件 | thinking |
|---|---|---|
| コード | 常に | medium |
| セキュリティ | 認証・認可・外部入力・秘密情報に触れる | high |
| テスト | テストの追加・変更がある | medium |
| アーキテクチャ | 集約境界・ドメイン層・公開 API に触れる | high |
| 仕様 | 要件定義・受け入れ条件がある | medium |

### 4. レビュアーを起動して投入する

プロンプトは `references/reviewer-prompt.md` のテンプレートから作る。
`{{EVIDENCE}}` に evidence.md のパスを、`{{CHECKLIST}}` に観点別チェックリストを埋める。

herdr を使う場合（ユーザーが herdr を指定したときのみ）:

```bash
test "${HERDR_ENV:-}" = 1 || { echo "herdr 外なので acp_delegate を使う"; exit 1; }

# ペインは --no-focus で作る。pane_id は必ず workspace 接頭辞付きの完全形で扱う
pane=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start code-reviewer --kind <kind> --pane "$pane"

# 待ち合わせは --wait。sleep ポーリングは禁止
herdr agent prompt code-reviewer "$(cat /tmp/review-<ticket>/prompt-code.md)" --wait --timeout 900000
```

herdr 指定が無ければ `acp_delegate`（`reviewer` / `researcher`）を使う。
完了通知が来るのでポーリング不要、出力は自動でファイルに退避される。

### 5. 結果を統合する

- MUST は改修必須。NITS も原則修正。IMO は、取り組むことで劇的にプロジェクトへのメリットが大きいと判断したものだけ取り入れる。
- 同じ指摘が複数レポートにあれば 1 件にまとめる。重複は観点設計の重複であり、品質ではない。
- MUST の根拠（file:line）を自分で 1 回だけ確認する。根拠が薄弱なものは落とす。
- 採否と理由を `findings.md` に残す（書式は `references/evidence-template.md` 末尾）。

### 6. 改修する

MUST を 1 件ずつ直し、直すたびに該当テストを回す。
最後に `npm run check` と `npm run smoke` を回す。
修正が新しい問題を生んでいないか、`findings.md` と突き合わせて確認する。

## 予算

| 対象 | 上限 |
|---|---|
| レビュアー 1 本のツール呼び出し | 20 回 |
| レビュアー 1 本の出力 | 60 行（MUST 多発時 80 行） |
| レビュー全体の wall-clock | 10 分 |
| evidence.md 生成 | 3 分 |

予算超過は「レビューが足りない」ではなく「evidence.md が足りない」のサイン。
事実を足して 1 本だけ再実行する方が、長時間回すより速く正確になる。

## 禁止事項

| 禁止 | 代わりに |
|---|---|
| レビュアーに `git diff` や docs を読ませる | evidence.md に diff と該当箇所を入れる |
| `sleep` でポーリング | `--wait` / 完了通知で待つ |
| レポートの採番・体裁を後から整えさせる | 出力契約で最初から表形式に固定する |
| 「など」で観点を開く | 観点を列挙して閉じる |
| 圧縮後に file:line を失って再検証 | evidence.md と findings.md を正とし、圧縮に依存しない |
| 5 本以上を同時に回す | 3 本以下、または 2 波に分ける |
| 全レビュアーを high thinking にする | 判断が重い観点だけ high |
| レポートを全部そのまま次の作業者に渡す | 統合済み findings.md（採用分のみ）を渡す |

## 完了条件

- 各観点のレポートがファイルとして存在する
- `findings.md` に採用 / 却下の判断と理由がある
- MUST がすべて解消され、`npm run check` が通る
