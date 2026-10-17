# Модель данных

Хранится через `loadData/saveData` в `.obsidian/plugins/osm-map-notes/data.json`. Типы — `src/types.ts`.

```ts
PluginData {
  settings: PluginSettings
  markers: MapMarker[]
  folders: MarkerFolder[]
  lastCamera: { center: [lng, lat], zoom } | null
  regions: OfflineRegion[]   // метаданные офлайн-областей; сами тайлы — в IndexedDB
}
```

## MapMarker
| Поле | Смысл |
|---|---|
| `id` | `uid()` — base36 время + случайный суффикс |
| `name` | подпись метки |
| `coords` | `[lng, lat]` |
| `notePath` | путь к заметке в хранилище, `""` — без заметки |
| `folderId` | папка или `null` (корень) |
| `color` | HEX |
| `cardOffset` | смещение левого верхнего угла карточки от метки, px экрана (по умолчанию `[40, -260]`) |
| `cardSize` | `[w, h]` px (по умолчанию `[300, 220]`) |
| `cardOpen` | карточка развёрнута |
| `hidden?` | скрыта с карты (в списке остаётся) |

## MarkerFolder
`id`, `name`, `parentId` (`null` — корень), `collapsed`, `hidden?`.

## Инварианты
- Метка видна на карте ⇔ `!hidden` и ни одна из папок-предков не `hidden` (`isMarkerVisible`).
- Удаление папки не удаляет содержимое: метки и подпапки переносятся к родителю удалённой папки.
- Удаление метки не трогает заметку.
- Состояние карточки (`cardOpen`, offset, size) сохраняется и у скрытых меток.

## Сохранение
- `plugin.save(notify = true)` — debounce 400 мс; при `notify` шлёт событие `changed` (перерисовка карты и списка).
- Частые изменения (камера, перетаскивание карточки) — `save(false)`.

## Миграции при загрузке (`onload`)
- `settings = { ...DEFAULT_SETTINGS, ...raw.settings }`; отсутствующие массивы → `[]`.
- Удаляется устаревшее поле `settings.themeOptions`.
- `defaultCenter`, `defaultZoom`, `flyDuration`, `flyZoom` больше не настраиваются и всегда перезаписываются значениями по умолчанию.
- Новые поля меток/папок делать опциональными, чтобы старый `data.json` оставался валидным.
