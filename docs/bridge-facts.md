# OpenWhispr CLI bridge — установленные факты (источник истины, перепроверять не нужно)

Инспекция `/Applications/OpenWhispr.app/Contents/Resources/app.asar` (Electron 1.9.2, macOS).

## CLI bridge (`/src/helpers/cliBridge.js`)

- HTTP на `127.0.0.1`, порт — первый свободный из **8200–8219**. Только loopback, иначе 403.
- Токен `crypto.randomBytes(32).hex` — **перегенерируется при каждом старте приложения**.
  При рестарте меняется **и порт тоже**.
- Порт и токен в `~/.openwhispr/cli-bridge.json` (mode 0600), файл **удаляется** при остановке моста.
  Форма файла: `{ "port": 8200, "token": "<64 hex>", "host": "127.0.0.1", ... }` (host может отсутствовать).
- Auth: `Authorization: Bearer <token>`, `timingSafeEqual` — при неверной длине заголовка тоже 401.
- Конверт успеха: `{"data": ...}`; списки — `{"data":[...], "has_more":false, "next_cursor":null}`,
  где **`has_more`/`next_cursor` жёстко зашиты в false/null** (бесполезны).
- **`DELETE` отвечает `204` с пустым телом** — конверта `{data}` там нет.
- Конверт ошибки: `{"error":{"code","message"}}`; коды `unauthorized` 401, `forbidden` 403,
  `not_found` 404, `validation_error` 400, `internal_error` 500.
- Лимит **1 MiB — только на тело запроса**. Размер ответа не ограничен ничем.

### Все 15 роутов

| Метод | Путь | Параметры |
|---|---|---|
| GET | `/v1/health` | — |
| GET | `/v1/notes/list` | `note_type`, `limit` (def 100), `folder_id` |
| GET | `/v1/notes/search` | `q` (обязателен), `limit` (def 20) |
| GET | `/v1/notes/:id` | — |
| POST | `/v1/notes/create` | `title`, `content`, `note_type`, `source_file`, `audio_duration_seconds`, `folder_id` → 201 |
| PATCH | `/v1/notes/:id` | тело → `db.updateNote` |
| DELETE | `/v1/notes/:id` | → 204 |
| GET | `/v1/folders/list` | — |
| POST | `/v1/folders/create` | `name` → 201 |
| GET | `/v1/dictionary/list` | — |
| POST | `/v1/dictionary/update` | `add[]`, `remove[]` |
| GET | `/v1/transcriptions/list` | `limit` (def 50) |
| GET | `/v1/transcriptions/:id` | — |
| DELETE | `/v1/transcriptions/:id` | → 204 |
| DELETE | `/v1/transcriptions/:id/audio` | → 204 |

Используем 13 из 15: удаление транскрипций и их аудио осознанно не выставляем.

## Слой данных (`DatabaseManager`, `/src/helpers/database.js`)

- `getNotes` → `... WHERE deleted_at IS NULL [+note_type][+folder_id] ORDER BY updated_at DESC LIMIT ?`.
  **Сортировка без вторичного ключа**: при равных `updated_at` порядок не определён, и в сочетании
  с `LIMIT` мост вправе вернуть произвольное подмножество таких строк.
- `searchNotes` → FTS5 `notes_fts(title, content, enhanced_content)`, `ORDER BY notes_fts.rank`
  (bm25). Запрос строится в `/src/helpers/noteSearch.js`: каждый токен `[\p{L}\p{N}_]...` → `"tok"*`,
  склейка пробелом = **implicit AND**, операторы FTS вырезаются, пустая токенизация → `[]`.
  Score наружу не отдаётся. Побочный эффект токенизатора: `"C++"` → один токен `C` → запрос
  `"C"*` матчит всё, начинающееся на C.

  **Уточнение (проверено реализацией в волне 1):** «операторы FTS вырезаются» — неточная
  формулировка. `AND`/`OR`/`NOT`/`NEAR` состоят из word-символов, поэтому токенизатор их
  **сохраняет** и оборачивает в кавычки: `проект AND отчёт` → `"проект"* "AND"* "отчёт"*`.
  Оператором они быть перестают, но превращаются в **обязательный литеральный терм** —
  запрос потребует слова «AND» в тексте заметки. Вырезаются только не-word символы
  (`"`, `*`, `+`, `-`, `^`, скобки). Это надо явно сообщать агенту в ответе `search_notes`.

  Точный исходник токенизатора (извлечён из `app.asar` в волне 1):
  ```js
  input.normalize("NFC").match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
       ?.filter(t => /[\p{L}\p{N}]/u.test(t))
  ```
  То есть: NFC-нормализация, `\p{M}` (комбинирующие знаки) разрешены внутри токена,
  и пост-фильтр выбрасывает токены из одних подчёркиваний. `src/domain/ftsQuery.ts`
  сделан точным зеркалом — иначе `tokens_used` врал бы про реально выполненный запрос.
- `getTranscriptions` → `... WHERE deleted_at IS NULL AND status != 'discarded' ORDER BY timestamp DESC`
  — soft-deleted и `discarded` наружу не видны вообще.
- `updateNote` — whitelist из 21 поля; **`note_type` изменить нельзя**; неизвестные поля молча
  игнорируются, а если после фильтрации не осталось ни одного — `{success:false}` без текста ошибки.
- `saveNote` с несуществующим `folder_id` — throw. Без `folder_id` заметка кладётся в дефолтную
  папку **по имени** (`note_type === "meeting"` ? `Meetings` : `Personal`).

## Форма данных

Заметка — 30 колонок: `id, title, content, note_type ('personal'|'meeting'|'upload'), source_file,
audio_duration_seconds, created_at, updated_at, enhanced_content, enhancement_prompt,
enhanced_at_content_hash, cloud_id, folder_id, transcript, calendar_event_id, participants,
diarization_enabled, expected_speaker_count, client_note_id, sync_status, deleted_at, is_shared,
share_token, space_id, account_id, left_team, updated_by_user_id, cloud_updated_at, owner_user_id,
created_by_user_id`. **Имени папки в строке заметки нет** — только `folder_id`.

Даты — строки `"2026-09-08 08:31:48"` (SQLite `CURRENT_TIMESTAMP`, **UTC без TZ**). Проверено:
`new Date("2026-09-08 08:31:48")` даёт `2026-09-08T05:31:48Z` — сдвиг на локальный TZ. Парсить
только через `Date.parse(s.replace(" ", "T") + "Z")`.

Папка: `id, name, is_default, sort_order, created_at, updated_at, client_folder_id, cloud_id,
sync_status, deleted_at, space_id, account_id, left_team`.

Транскрипция: `id, text, timestamp, created_at, raw_text, has_audio, audio_duration_ms, provider,
model, status ('completed'|'failed'|'pending'|'discarded'), error_message, error_code, route_kind,
client_transcription_id, cloud_id, sync_status, deleted_at`.

**Связи `notes` ↔ `transcriptions` не существует** — ни FK, ни `note_id`. Это два независимых потока:
`transcriptions` — история диктовок, транскрипт митинга живёт в `notes.transcript`.

**`notes.transcript`** — TEXT, содержит либо JSON-массив сегментов, либо плоский текст (legacy /
fallback). Дискриминатор в приложении — `raw.startsWith("[")`. Ключи сегмента: `text`,
`source` (`mic`|`system`), `timestamp` (**epoch мс**), `speaker` (`speaker_0`|`you`), `speakerName`,
`speakerIsPlaceholder`, `suggestedName`, `suggestedProfileId`, `speakerStatus`
(`provisional`|`confirmed`|`suggested`|`locked` + legacy `suggested_profile`, `user_locked`,
`uncertain_overlap`), `speakerLocked`, `speakerLockSource`. Полей `start`/`end`/`words` нет.

Приложение приводит timestamp к относительным секундам по эвристике «вычесть минимум и делить на
1000, если минимум `> 1e9`». **Эвристика неверна для epoch в секундах** (`1.78e9 > 1e9` → делит
секунды на 1000), копировать нельзя.

Реальные объёмы: **одна заметка = 58 KB JSON / 202 сегмента**, вторая — 836 сегментов (≈240 KB).
Имена спикеров из `speaker_mappings` через bridge **недоступны**.

## Ограничения bridge, которые закрывает MCP

1. **Пагинации нет** — только `limit`.
2. **Нет валидации входов**: `?limit=abc` → HTTP **500** "datatype mismatch" (SQL-ошибка наружу);
   `?limit=-5` молча игнорируется.
3. **Доменные ошибки приходят как 500**: `"Folder not found in the active account scope"`,
   `"Folder not found"`, `"A folder with that name already exists"`,
   `"Folder name is required"`, `"Failed to write note"`.
4. **Нет роутов** для usage/статистики, плана подписки, транскрипта заметки, spaces,
   rename/delete папок, экспортов.
5. **Семантический поиск существует, но только через внутренний IPC** (`db-semantic-search-notes`):
   Qdrant-сайдкар, локальные ONNX-эмбеддинги all-MiniLM-L6-v2, гибрид FTS5 + вектор через RRF.
   Наружу по HTTP не выведено.
6. **Usage/план — только облако**: IPC `cloud-usage` → `GET https://api.openwhispr.com/api/usage`.
   Локально приложение статистику не считает и не хранит.

## Прямое чтение SQLite отвергнуто

БД: `~/Library/Application Support/open-whispr/transcriptions.db` (WAL). При чтении с
`immutable=1` таблица `notes` показала 1 запись, тогда как bridge отдавал 2 — свежие данные
лежали в WAL. Плюс схема наращивается цепочкой `ALTER TABLE` без версионирования миграций.

## Совместимость стека (проверено по установленным пакетам)

`@modelcontextprotocol/sdk` 1.30.0 объявляет `zod: ^3.25 || ^4.0` и содержит
`zod-json-schema-compat`: для zod 3 — `zod-to-json-schema`, для zod 4 — встроенный
`zod/v4-mini.toJSONSchema`. `registerTool` принимает и raw shape, и полноценную `z.object`.

**Но**: SDK валидирует аргументы сам и передаёт в хендлер **уже распарсенный** объект, а zod по
умолчанию отбрасывает неизвестные ключи. Значит «второй проход со `.strict()`» внутри хендлера
неизвестного ключа уже не увидит — валидировать нужно **той же схемой, что зарегистрирована**.

Окружение: Node v26.8.1, npm 11.19.0, zod 4.5.4.
