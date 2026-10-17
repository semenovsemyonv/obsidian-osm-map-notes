# Офлайн-режим

## Режимы
- `settings.mapMode`: `online` — тайлы из сети; `offline` — только скачанные области.
- Векторная карта работает только онлайн. В офлайне всегда используется растровая подложка (`currentProvider()`, т.е. OSM или свой URL).
- `offlineNetworkFallback` — в офлайне догружать из сети тайлы, которых нет в хранилище (если `navigator.onLine`).
- Без fallback `maxzoom` источника = максимальный скачанный масштаб; выше карта растягивает имеющиеся тайлы.

## Области (`OfflineRegion`)
`id, name, providerKey, providerName, tiles (шаблоны URL), bounds [W,S,E,N], maxZoom, tileCount, bytes, failed, downloadedAt`.
- Создаются из видимой области карты в `OfflineModal`; скачиваются все масштабы от 0 до `maxZoom`.
- Шаблоны URL сохраняются в области, чтобы её можно было обновить после смены подложки.

## Ограничения (правила tile.openstreetmap.org)
- `MAX_TILES_PER_REGION = 30000`.
- Максимальный масштаб для OSM — 16 (`PROVIDER_MAX_OFFLINE_ZOOM`).
- Параллельность: 2 запроса к OSM, 4 — к прочим.
- Оценка размера — 25 КБ/тайл.

## Скачивание (`OfflineManager`)
- Очередь заданий `download | update`, одно активное задание (`job`). Повторная постановка той же области игнорируется.
- `download` пропускает тайлы, уже лежащие в хранилище; `update` перекачивает всё.
- Ошибки тайлов считаются в `failed`, задание не прерывается. Отмена — флаг `job.cancelled`.
- События: `offline-progress` (не чаще 150 мс), `offline-changed`. По завершении очереди в офлайн-режиме — `tiles-changed`.
- Удаление области стирает только тайлы, не входящие в другие области той же подложки (пачками по 2000).

## Хранилище тайлов
- IndexedDB `map-notes-tiles-<appId>`, store `tiles`, ключ `<providerKey>/<z>/<x>/<y>`, значение `{ data: ArrayBuffer, t }`.
- Локально на устройстве, не синхронизируется.

## Протокол `mapnotes://`
- Регистрируется `maplibregl.addProtocol` в конструкторе `OfflineManager`, снимается при выгрузке.
- URL: `mapnotes://<encodeURIComponent(providerKey)>/{z}/{x}/{y}`.
- Отдаёт `ImageBitmap` (сырые байты из кастомного протокола MapLibre 4 не отрисовывает); отсутствующий тайл — прозрачный PNG 1×1.
