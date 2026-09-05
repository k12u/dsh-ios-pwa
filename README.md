# DSH Mobile

DeepSeek Harness をスマートフォンから操作する React / TypeScript PWA と、同一 origin で配信する薄い Gateway。

**実装・契約テスト段階です。実際の Harness 起動、iPhone / Android、Push 配信の受け入れ検証はまだ完了していません。** 対象 API は公式 Harness 0.1.2-rc.1 の配布物と参考 Gateway 0.7.1 に照合しました。現在の制約と確認項目は [docs/acceptance.md](docs/acceptance.md) に記録しています。

## ローカルプレビュー

Node.js 22.12 以上（CI は 24）で実行します。

```sh
npm ci
npm run build
npm run dev
```

コンソールの `http://localhost:8787/pair?t=...` を5分以内に開きます。プレビューの Agent はデモで、モデルや shell を実行しません。Inbox の承認・質問、Sessions、会話のストリーミング、画像添付を確認できます。再起動でデモ状態とデバイス認証はリセットされます。

`localhost` と `127.0.0.1` は異なる origin です。ブラウザでは表示された localhost のリンクを使ってください。HTTP の例外は loopback 開発専用です。スマートフォンへの配信には HTTPS origin を設定した Harness plugin を使います。

Mac の Node.js / pnpm 自体が未導入なら、ユーザーの nix-darwin / Home Manager 構成で管理してください。このプロジェクトはシステムやシェル設定を変更しません。

## Harness plugin として使う

1. 公式 `dsh web` が動くホストへこのリポジトリを配置し、依存インストールとビルドを実行します。
2. `gateway/cordis.patch.yml` の `publicOrigin` を実際の PWA の HTTPS origin に変更します。
3. plugin を追加して Harness を再起動します。

```sh
dsh plugin --profile web add link:/absolute/path/dsh-ios-pwa/gateway
dsh web
```

例:

```yaml
- insert:
    - id: mobile-pwa
      name: dsh-plugin-mobile-pwa
      config:
        publicOrigin: https://your-host.example
        port: 8787
        pushSubject: mailto:operator@example.com
```

`pushSubject` を省略すると Push capability は公開されません。VAPID 鍵・認証済みデバイスのハッシュ・Push subscription は `~/.local/state/dsh-mobile/` に mode 0600 で保存します。`dataDir` または `DSH_MOBILE_DATA_DIR` 環境変数で保存先を変更できます（`dataDir` が優先）。互換性 smoke test は一時ディレクトリへ分離します。データは Git に含めないでください。

Gateway は `127.0.0.1:8787` のみで待ち受けます。Tailscale Serve または HTTPS reverse proxy の転送先をこのポートに設定します。外部へ転送するのは Gateway のポートのみです。Harness Web UI のポートや raw Remote API は転送しません。Gateway が `/`、`/api/*`、`/ws/mobile`、`/push/*` をまとめて配信します。

Harness ホストの `http://localhost:<Harness のポート>/mobile-pwa` を開くと、5分間・一度限り有効な pairing QR / リンクを発行できます。スマートフォンの標準カメラで読み取って接続してください。初回起動時はコンソールにもリンクが出ます。認証済みデバイスの失効は PWA の Settings で実行できます。

このローカル管理ページは現在サイドバーへのリンク追加を行いません。上記 URL を直接開いてください。ブラウザには長期 token を返さず、`HttpOnly; Secure; SameSite=Strict; Path=/` Cookie を設定します。

## 構成と境界

```text
Official Harness (外部 runtime)
  → gateway/src/adapters/
  → gateway/src/normalization/adapter.ts
  → packages/protocol/ (Zod + TypeScript)
  → packages/domain/
  → web/src/state/ + projections/
  → React UI
```

- `packages/protocol`: 独立した Mobile Protocol v1。参考 native client の wire protocol とは別契約です。未知フィールドを除去し、未知イベントを無視します。
- `gateway/src/adapters`: Host API、raw event、HITL waterfall、task / goal projection を正規化。PWA は Harness version を知りません。
- `gateway/src/auth`: 一度限りの pairing、期限付き Cookie、失効、rate limiting。
- `gateway/src/push`: Node crypto / fetch による RFC 8291 暗号化・RFC 8292 VAPID。通知本文にはツール引数や会話本文を含めません。
- `web`: Inbox / Tasks / Sessions、Conversation / Activity / Files、generic approval / question renderer、再接続、PWA shell。
- `vendor/mobile-gateway`: 参考 Gateway の保存済みソースと契約テスト。配布に含まれません。再利用する Host Adapter のみ `gateway/src/adapters/upstream` に配置しています。

Harness 本体の fork・同梱・native wrapper はありません。GitHub 上の fork や公開リポジトリの作成、デプロイは行っていません。

raw API を React に渡さない境界は、import の解決先を検査するテストと、Adapter に余分な内部フィールドを混入させる HTTP 契約テストで保護しています。履歴・snapshot・session 作成結果・realtime event は送信前に共有 Zod schema を通します。例えば `assistant/chunk` は Adapter で `message.delta` へ変換し、PWA が `turn` / `step` / `chunk` を解釈することはありません。Activity に表示する引数・結果も正規化された文字列 preview です。

## 同期と操作

接続は hello → authoritative snapshot → その取得中にバッファしたイベントの順です。選択中セッションの履歴も再取得し、完了するまで書き込みを無効にします。表示状態を WebSocket の再接続だけで復元しません。

履歴と live event は Adapter で同じ ID / seq を生成します。遅延した履歴ページも受け付け、message completion の本文を正とします。HITL は receipt で確定せず、正式な resolved event または再接続時の snapshot で確定します。prompt の同一 request ID は Gateway の同一プロセス内で24時間重複実行を防ぎます。ブラウザから自動的に再送はしません。

background 時にソケット維持を前提とせず、visibility / pageshow / online で再同期します。401 は再試行を止めて pairing 画面へ、停止中の Gateway は最大約30秒の再試行間隔になります。

画像は PNG / JPEG / WebP / GIF、1枚3.5 MB、4枚までの client 上限があります。実際の画像検証・セッション所属確認は公式 Harness が担当します。画像は Cookie で保護した専用ルートから取得します。任意パスでファイルを読む API はありません。一般ファイルの転送・SHA-256 download 検証・Web Share は Phase 2 です。

## PWA と更新

Manifest、192/512px アイコン、standalone、safe-area 対応を含みます。Service Worker は public shell / hashed assets と Push だけを扱います。API、pairing、会話、認証情報は Cache API に保存しません。

IndexedDB には最大50件ずつの workspace / session / task summary を最長7日保存します。会話・画像・ツール結果・未解決の承認 / 質問は保存しません。オフラインでは最後に取得した情報を表示し、書き込みを無効にします。

更新バナーから利用者が明示的に再読み込みします。Agent や操作中の UI を自動的に再読み込みしません。

iPhone の Push は Home Screen に追加して開いた状態から Settings の通知許可を操作してください。購読 API がないブラウザには説明を表示します。Push provider は Apple / FCM / Mozilla / Windows の指定ホストに限定し、外部 URL を任意に fetch する機能にはしません。

## 検証

```sh
npm run build
npm test
npm run test:upstream
npm run test:network
```

`npm test` はビルド後に実行します。HTTP handler、実 WebSocket フレームのメモリ内転送、同時 snapshot / event、Origin / Cookie / revoke、request idempotency、履歴 merge、HITL、XSS、PWA assets、Push の RFC 公開ベクトルを検証します。

`test:network` は TCP が使える環境向けです。実ソケットによる pairing / streaming / reconnect を追加検証します。`test:upstream` は保存した元 Host Adapter の契約テストです。元 Gateway の全テストを実行済みとするものではありません。

```sh
DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:harness
```

Harness smoke は一時的な `DSH_HOME` を使い、公式 runtime + plugin 起動・static serve・pairing・host/workspace/session snapshot を確認します。モデルを使う prompt/HITL/image の全経路は別途実接続で検証が必要です。

CI は build / contracts / network smoke と、stable / RC / alpha の最新公開版に対する週次・手動 Harness boot matrix を含みます。**CI はまだ実行しておらず、全 channel の互換性を保証していません。**

静的レイアウト資料も生成できます。

```sh
npm run preview:static
```

`test-results/preview.html` は通信しない画面プレビューです。

## 一体配布

```sh
npm run build
npm pack --workspace gateway
```

tarball に Gateway、共有契約のコンパイル結果、PWA assets が入ります。runtime dependency は ws と zod のみで、Harness は外部のままです。Protocol を変更するときもこの配布単位を更新します。

参考: [Mobile Gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway)、[native mobile client](https://github.com/Clarklevis1995/dsh-mobile)、[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)、[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)。由来とライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
