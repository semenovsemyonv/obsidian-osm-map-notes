# Map Notes (OpenStreetMap) — плагин Obsidian

Заметки на карте: метки на карте MapLibre, раскрывающиеся карточки с отрендеренной заметкой, список меток с папками, векторные темы OpenFreeMap и офлайн-скачивание растровых тайлов OSM. Весь UI и тексты — на русском.

Спецификации: [docs/specs/](docs/specs/) — функциональность, модель данных, офлайн, векторные стили. Пользовательская документация — [README.md](README.md).

## Команды

```bash
npm install
npm run dev      # esbuild watch → main.js (с inline sourcemap)
npm run build    # tsc --noEmit + production-сборка (minify)
```

Тестов и линтера нет; проверка — `npm run build` и ручной прогон в Obsidian.

## Деплой в тестовое хранилище

Плагин установлен в `/Users/semensemenov/Documents/Obsidian/Personal/.obsidian/plugins/osm-map-notes/`. После сборки скопировать туда три файла и перезагрузить плагин в Obsidian:

```bash
cp main.js manifest.json styles.css "/Users/semensemenov/Documents/Obsidian/Personal/.obsidian/plugins/osm-map-notes/"
```

`data.json` в папке плагина — реальные данные пользователя (метки/папки/настройки), не перезаписывать.

## Стек

- TypeScript (ES2018, `strictNullChecks`, `noImplicitAny`), esbuild → один CJS-файл `main.js`.
- `obsidian` API (внешний модуль), `maplibre-gl` 4.x (вшивается в бандл, ~0.9 МБ).
- CSS MapLibre импортируется как текст (`loader: { ".css": "text" }`, декларация в `src/css.d.ts`) и вставляется `<style>` в `onload` — Obsidian подключает только `styles.css` плагина.
- Сеть — только через `requestUrl` из Obsidian (обходит CORS). Внешние сервисы без ключей: тайлы OSM/OpenFreeMap, геокодеры Nominatim и Photon.

## Структура `src/`

| Файл | Назначение |
|---|---|
| `main.ts` | `MapNotesPlugin`: загрузка/миграция `data.json`, CRUD меток, папок и связей, логика видимости, шина событий, команды, обновление путей при переименовании заметок |
| `types.ts` | Интерфейсы данных (`MapMarker`, `MarkerFolder`, `MarkerLink`, `PluginSettings`, `OfflineRegion`), `DEFAULT_SETTINGS`, палитра, растровые провайдеры, `uid()` |
| `mapView.ts` | `MapView` (ItemView, тип `gis-map-notes-view`): карта MapLibre, сборка стиля, DOM/SVG-оверлей меток, карточек и связей, тулбар, контекстные меню, drop заметок, перелёт к метке с ограничением скорости (`flyTo`) |
| `sidebar.ts` | Правая выезжающая панель: дерево папок/меток, поиск, drag & drop, скрытие (глаз) |
| `modals.ts` | `NotePickerModal`, `PromptModal`, `ConfirmModal`, `ColorModal` |
| `settings.ts` | Вкладка настроек (`MapSettingTab`) |
| `vectorStyle.ts` | Загрузка стилей OpenFreeMap и их перекраска: язык подписей, схемы light/dark/jojo, плоские и 3D-здания (цвета в OKLab) |
| `offline.ts` | `OfflineManager`: протокол `mapnotes://`, очередь скачивания областей, тайловая математика |
| `tileStore.ts` | Обёртка IndexedDB для тайлов |
| `offlineModal.ts` | Модалка «Офлайн-карты»: создание/обновление/удаление областей, прогресс |
| `geocoder.ts` | Поиск адреса: нормализация русских сокращений, Nominatim + Photon, объединение и ранжирование |
| `geo.ts` | Web Mercator ↔ lng/lat, easing, пересечение отрезка с прямоугольником |

## Архитектура

- **Единый источник правды** — `plugin.data` (`PluginData`). Все изменения идут через методы плагина (`addMarker`, `updateMarker`, `updateFolder`, …) → `save()` (debounce 400 мс) + событие.
- **События `plugin.events`:**
  - `changed` — метки/папки изменились → `MapView.sync()` + `sidebar.render()`;
  - `note-modified` (path) — перерендер карточки;
  - `tiles-changed` — пересобрать стиль карты (`setStyle(..., {diff:false})`);
  - `offline-changed`, `offline-progress` (job) — состояние скачивания.
  - `save(false)` сохраняет без `changed` — для частых обновлений (камера, положение карточки при перетаскивании).
- **Рендер меток не через `maplibregl.Marker`**, а свой оверлей поверх карты: `.gis-pins`, `.gis-cards`, SVG `.gis-lines`. На каждый `move` — `updatePositions()` проецирует координаты и двигает элементы через `transform`. `sync()` диффит DOM с данными по `id`.
- **Связи** (`data.links`) рисуются в той же SVG, в группе `.gis-links` под линиями карточек; геометрия (линия, стрелки-полигоны, надпись) пересчитывается в `updateLinkPositions()` из `updatePositions()`. Режим создания связи — `linkFrom` в `MapView`.
- **Карточка** хранит смещение от метки в пикселях экрана (`cardOffset`) и размер (`cardSize`); тело — `MarkdownRenderer` с собственным `Component` на карточку.
- **Стиль карты** (`buildStyle` в `mapView.ts`): vector + online → OpenFreeMap; иначе растровый источник; в офлайне URL тайлов подменяется на `mapnotes://<providerKey>/{z}/{x}/{y}`.
- **3D** (`plugin.is3d()`) только для vector + online + `buildings3d`: включает наклон/поворот, иначе камера сбрасывается в pitch 0 / bearing 0.

## Соглашения

- Адаптивность — через `@container gis-map` (ширина вида, не устройства) и `body.is-phone` для отступа от панели навигации Obsidian; порог синхронизирован с `NARROW_WIDTH` в `mapView.ts`.
- CSS-классы с префиксом `gis-`, стили — в `styles.css`, используются переменные темы Obsidian.
- Комментарии и UI-строки на русском; отступы — табы.
- Координаты всегда `[lng, lat]`; bounds — `[запад, юг, восток, север]`.
- Новые поля настроек добавлять в `PluginSettings` + `DEFAULT_SETTINGS` (слияние со старым `data.json` происходит в `onload`). Поля `defaultCenter/defaultZoom/flyDuration/flyZoom` принудительно сбрасываются к значениям по умолчанию.
- Новые необязательные поля меток/папок — опциональные (`?`), чтобы старые данные оставались валидными.
- Подписка на события — через `registerEvent`/`registerDomEvent`/`register`, чтобы всё снималось при выгрузке.
- Уважать правила tile.openstreetmap.org: ≤2 параллельных запроса, zoom ≤16, ≤30 000 тайлов на область. Nominatim — ≤1 запрос/с, только по Enter (без автодополнения).
- Не передавать `padding` в `easeTo/flyTo` — у MapLibre он становится постоянным; использовать `fitBounds` или сдвигать центр вручную (как в `flyTo`).

## Релиз

Версия в `manifest.json`, `package.json` и `versions.json` (версия → `minAppVersion`). В GitHub-релиз прикладываются `main.js`, `manifest.json`, `styles.css`. `main.js` в `.gitignore`.
