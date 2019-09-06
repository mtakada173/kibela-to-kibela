# Kibela to Kibela import script [![Build Status](https://travis-ci.org/kibela/kibela-to-kibela.svg?branch=master)](https://travis-ci.org/kibela/kibela-to-kibela)

**注意: このスクリプトは現在開発中です。実際のデータで試すことはおすすめません。もし実行する場合は自己責任でお願いします。**

ある [Kibela](https://kibe.la) team の「エクスポート」機能でエクスポートしたZIPファイルを、ほかのKibela teamにimportしなおすスクリプトです。

このスクリプトでimportしたコンテンツは、importスクリプトのログファイルに基づいて削除もできます。つまり、何度でも実行と実行の取り消しをできるようになっています。

## importスクリプトの作業フロー概要

1. kibela-import.ts の実行
2. kibela-fixup-contents.ts の実行
3. 内容を確認して問題があったら kibela-unimport.ts を実行して一旦削除する
    * → 1. からやりなおし

kibela-import.ts 自体には重複実行を抑制する機能はないので、問題があったら常にunimportする必要があります。

なお、unimportはnote, comment, attachmentのみを削除します。作成されたuserとgroupはunimportを実行しても削除されません。

## コマンド

ping以外のスクリプトはデフォルトで **dry-run** を行います。実際に適用するときは `--apply` オプションを与えてください。

### kibela-ping.ts

Kibela Web APIを叩くための設定を確認するためのスクリプトです。

なおこの "ping" スクリプトはその他のスクリプトでも冒頭で呼ばれるようになっています。

### kibela-import.ts

実際にリソースのimportを行うスクリプトです。importするリソースはNote, Comment, Attachmentです。それぞれの更新履歴やLikeは維持されません。

このスクリプトは最終的に `transaction-*.log` というログを生成します。

このログは次に `kibela-fixup-contents` を実行するときに必要です。また、ログを `kibela-unimport` スクリプトに与えると、importしたリソースをすべて削除します。

`--exported-from <subdomain>` オプションでexport元のsubdomainを指定してください。

なお、デフォルトではdry-runモードで起動するため何も処理をしません。処理を実際に行いたいときは `--apply` オプションを与えてください。

```console
./kibela-import.ts --exported-from <subdomain> [--apply] kibela-<subdomain>-<n>.zip...
```

## kibela-fixup-contents.ts

`kibela-import` でimportしたcontentにあるexport元のリンク / URL をimport先のものにベストエフォートで修正します。

ただし、Kibelaは歴史的経緯により様々なURLフォーマットがあり、すべてを正しく修正できるわけではないことをご了承ください。

`--exported-from <subdomain>` オプションでexport元のsubdomainを指定してください。

なお、デフォルトではdry-runモードで起動するため何も処理をしません。処理を実際に行いたいときは `--apply` オプションを与えてください。

```console
./kibela-fixup-contents.ts --exported-from <subdomain> [--apply] transactio-*.log
```

### kibela-unimport.ts

`kibela-import` でimportしたリソースを削除します。

import後に行ったリソースの変更もすべて削除されるため注意してください。

なお、デフォルトではdry-runモードで起動するため何も処理をしません。処理を実際に行いたいときは `--apply` オプションを与えてください。

```console
./kibela-unimport.ts [--apply] transactio-*.log
```

## Prerequisites

NodeJS v12 or greater.

## Setup

```shell-session
# Install dependencies
npm install

# Configure KIBELA_TEAM and KIBELA_TOKEN
code .env

npm run ping # to test configurations
```

## See Also

* https://github.com/kibela/kibela-api-v1-document

## License

This project is destributed under the ICS license.

See [LICENSE](./LICENSE) for details.
