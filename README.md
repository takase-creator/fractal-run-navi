# FRACTAL RUN NAVI

住所と「今日走りたい距離」を入れると、**クチコミの多い人気スポットを経由するランニングコース**を
自動で組み立てるWebアプリ。iPhoneのSafariでそのまま動く（インストール不要・PWA対応）。

👉 **https://takase-creator.github.io/fractal-run-navi/**

---

## できること

| | |
|---|---|
| コース生成 | 出発地＋距離（1/3/5/10/15km・0.5km刻みで30kmまで）→ 実際の徒歩ルートを3案 |
| コースの形 | **周回**（出発地に戻る・行きと帰りで景色が変わる）／**往復**／**片道** |
| 立ち寄り先 | Googleの**クチコミ件数**が多い順に優先。おまかせ／景色・公園／名所・神社仏閣／カフェ・飲食 |
| ナビ | ワンタップで **Googleマップアプリ**の徒歩ナビへ（経由地込み） |
| 所要時間 | 自分の実績ペースから予測。走るほど精度が上がる |
| ラン記録 | GPSで距離・タイム・1kmスプリットを記録（スリープ抑止つき） |
| ヘルスケア連携 | `export.xml` を読み込んで過去のランからペースを算出／記録をCSV・GPXで書き出し |

---

## 2つのデータソース

| | Google モード | オープンデータ モード（既定） |
|---|---|---|
| 人気度の指標 | **Googleのクチコミ件数**＋星評価 | **Wikipedia月間閲覧数** ＋ OSMのタグ |
| スポット検索 | Places API (New) `searchNearby` | Overpass API |
| 徒歩ルート | Directions API | FOSSGIS OSRM（`routed-foot`） |
| 住所検索 | Geocoding API | Nominatim |
| 準備 | APIキーが必要（無料枠あり） | **不要・すぐ使える** |

設定画面でAPIキーを入れるとGoogleモードに切り替わる。キーは**この端末のlocalStorageにだけ**保存され、
サーバーには一切送信されない。

### Googleモードを使う場合

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. **Maps JavaScript API** / **Places API (New)** / **Directions API** / **Geocoding API** を有効化
3. 認証情報 → APIキーを作成
4. キーの制限 → アプリケーションの制限＝**ウェブサイト** → `https://takase-creator.github.io/*` を追加
5. アプリの設定画面に貼り付け

1回の検索で消費するAPIコールは **スポット検索5〜8回＋ルート計算4〜7回**。
スポット検索結果は同じ場所・同じ距離なら7日間キャッシュするので、いつもの出発地なら2回目以降はほぼ0。

---

## コース生成のしくみ

**周回モード**は、出発地を頂点のひとつに含む正多角形として近似する。
頂点数 V の正多角形の外接円半径 Rc と周長 T の関係は

```
T = V · 2Rc · sin(π/V)   →   Rc = T / (detour · V · 2 · sin(π/V))
```

`detour` は直線距離に対する実際の道路距離の比（初期値 1.28）。多角形の中心を出発地から
方位 θ₀ に Rc だけ離した位置に置き、θ₀ を振ることで構造の違う周回コースを複数作る。
各頂点は、その近傍で最も人気のあるスポットにスナップする（人気度 − 理想位置からのズレ×係数）。

計算量を抑えるため、

1. 直線距離での見積もり（API不要）で候補を絞る
2. 生き残った候補だけ実際にルーティング
3. 最初の実ルートから `detour` を学習し直し、1回の補正で目標距離に収束させる

**片道**は目標距離Tの位置、**往復**はT/2の位置にゴールを置いて同じ手順を踏む。

---

## Apple ヘルスケアについて（正直な話）

iOSはWebブラウザにHealthKitを開放していないため、Safariから直接ヘルスケアを読み書きすることは**できない**。
このアプリは公式のデータ書き出しを橋渡しに使う。

**ヘルスケア → 自分のペースを取り込む**
ヘルスケアアプリ → 右上のプロフィール → 「すべてのヘルスケアデータを書き出す」 →
できたzipを解凍 → 中の `export.xml` を設定画面から読み込む。
数百MBあるのでDOMには載せず、6MBずつスライスして走査する。
`<Workout>` は iOS 14以前（`totalDistance` 属性）と iOS 15以降（`<WorkoutStatistics>` 子要素）の
両方の書式に対応。

**アプリの記録 → ヘルスケアへ戻す**
CSV／GPXで書き出せる。ヘルスケアへの直接書き込みはOS制約でできないので、
RunGap・HealthFit などの取り込み対応アプリを経由する。

---

## ローカルで動かす

ES modulesは使っていないが、`file://` だとCORSでAPIが叩けないのでHTTP経由で開く。

```bash
cd ~/run-navi && python3 -m http.server 8080
```

## 構成

```
index.html            画面（5ビュー：コース／詳細／走る／履歴／設定）
css/app.css
js/util.js            測地計算（haversine・方位・目標点）と整形
js/store.js           localStorage永続化・ペースモデル・POIキャッシュ
js/providers.js       Google / OSM の2バックエンド（同一インターフェース）
js/planner.js         コース生成アルゴリズム
js/mapview.js         Leaflet描画
js/tracker.js         GPS記録・Wake Lock・スプリット・GPX
js/health.js          export.xml ストリーミング解析・CSV取込
js/app.js             UI配線
sw.js                 Service Worker
```

## データの扱い

出発地履歴・走行記録・APIキー・ヘルスケアの取込結果は、すべて**端末のlocalStorageのみ**に保存される。
アプリ独自のサーバーは存在せず、外部に送信されるのは地図タイル・経路計算・スポット検索の
リクエストだけ。

---

© OpenStreetMap contributors · CARTO · Wikipedia · FOSSGIS OSRM · Google Maps Platform
