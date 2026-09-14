# 巣穴管理フィールドマップ

巣穴の位置、F・M個体、リング番号、ロガー状態を年別・区画別に記録するWebアプリです。サイトを開くと年ページを選べ、閲覧はそのまま、編集だけパスワード確認後に行えます。

## 必要なもの

- Node.js `22.13.0`以降
- Cloudflare D1データベース
- 非公開の環境変数 `APP_PASSWORD`

## 手元で開く

1. `.env.example`を`.env.local`という名前で複製します。
2. `.env.local`の`APP_PASSWORD`に使用するパスワードを設定します。
3. 次のコマンドを実行します。

```bash
npm install
npm run dev
```

表示された`http://localhost:...`をブラウザで開いてください。

## パスワードの扱い

サイトの閲覧にはパスワードは不要です。画面の「編集する」を押した時だけパスワードを確認し、正しい場合に新規作成・変更・削除が有効になります。

年ページの削除は、年一覧で編集モードを有効にした場合だけ表示されます。削除前に対象年の全区画・巣穴・地図内容が消える警告を表示し、編集開始時とは別にパスワードを再確認します。

実際のパスワードは、GitHubへアップロードするファイルに書かないでください。Cloudflareで公開する場合は、WorkerのSecretとして`APP_PASSWORD`を設定します。編集を終了すると認証情報を削除し、再び読み取り専用になります。

## 確認コマンド

```bash
npm run build
```

## GitHubにアップロードするファイル

この完成版にはソースコードと公開に必要な設定だけを収録しています。`node_modules`、`dist`、`.next`、`.wrangler`などはアップロード不要で、インストールやビルド時に自動生成されます。

## Cloudflare Workersへ公開

1. CloudflareのD1で`site-creator-d1`というデータベースを作成し、表示されたDatabase IDをコピーします。
2. Workerの「Settings」→「Build」→「Build Variables and Secrets」に、`D1_DATABASE_ID`としてDatabase IDを登録します。
3. Workerの「Settings」→「Variables & Secrets」に、Secretの`APP_PASSWORD`を登録します。
4. Build commandを`npm run build`、Deploy commandを`npx wrangler deploy`にしてデプロイします。

`APP_PASSWORD`は実際のサイトで使用する秘密情報、`D1_DATABASE_ID`はビルド時にWrangler設定を生成するための値です。
