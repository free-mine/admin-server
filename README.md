# OreVein Admin Server

Локальный backend панели владельца Free Mine. Клиент заказывает операцию целиком;
сервер подписывает и последовательно выполняет её шаги, сообщает статусы через
REST и WebSocket. Фронтенд в этот репозиторий не входит.

Сеть: **Avalanche C-Chain, chainId 43114**. Контракты соответствуют
[free-mine/contracts, 5b7bd28](https://github.com/free-mine/contracts/tree/5b7bd28).
Капитал и NFT позиций остаются у `OreVein`, газ оплачивает EOA владельца.
При запуске проверяются сеть, владелец `OreVein`, связь с `FreeMine` и владение
`FreeMine` со стороны `OreVein`.

Поддерживаются конкретные контракты WAVAX, USDT, USDC и BTC.b из
[src/config/constants.ts](src/config/constants.ts). Произвольные адреса токенов,
сырой `execute`, передача владения, активация и отзыв прав администратора в API отсутствуют.

## Сборка и запуск

Нужен Docker с Linux-контейнерами. Node.js на компьютере для запуска образа не требуется.

```sh
docker build -t ore-vein-admin-server:local .
```

Создайте `.env` по образцу [.env.example](.env.example). В PowerShell:

```powershell
Copy-Item .env.example .env
```

Заполните обязательные параметры реальными значениями:

```dotenv
RPC_URL=https://avax-mainnet.g.alchemy.com/v2/YOUR_API_KEY
PRIVATE_KEY=0xYOUR_OWNER_PRIVATE_KEY
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Ключ — 64 шестнадцатеричных символа, с `0x` или без него. Пароль и зашифрованный
формат старого CLI не используются. На EOA нужен AVAX для газа.
RPC должен поддерживать чтение состояния, `eth_getLogs`, `eth_estimateGas` и
отправку подписанных транзакций Avalanche.

### Docker Compose

Готовый [compose.yml](compose.yml) публикует порт только на loopback-интерфейсе:

```sh
docker compose up -d --build
docker compose logs -f admin-server
```

Адрес API: `http://127.0.0.1:3000`. Журнал сохраняется в именованном volume
`admin-data`; Compose добавляет к имени префикс проекта.

```sh
docker compose stop
docker compose start
```

Для обновления кода снова выполните `docker compose up -d --build`.
Обычный `docker compose down` сохраняет volume. Флаг `-v` удаляет журнал и для
обычных перезапусков не нужен.

### Docker без Compose

```sh
docker volume create ore-vein-admin-data
docker run -d --name ore-vein-admin --init --restart unless-stopped --stop-timeout 30 --env-file .env -p 127.0.0.1:3000:3000 --mount type=volume,source=ore-vein-admin-data,target=/app/data ore-vein-admin-server:local
docker logs -f ore-vein-admin
```

```sh
docker stop ore-vein-admin
docker start ore-vein-admin
```

Один кошелёк обслуживает **один экземпляр сервера**. Журнал и очередь не рассчитаны
на несколько одновременно работающих контейнеров. Пока сервер работает,
подписывайте операции этого кошелька через него; восстановление после внешней
замены транзакции описано ниже.

Образ работает от пользователя `node`, UID 1000. Именованный volume получает
подходящего владельца автоматически. Для bind mount обеспечьте запись UID 1000.
В образ не попадают `.env`, `old/`, тесты и приватный ключ.

### Проверка запуска

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3000/ready
Invoke-RestMethod http://127.0.0.1:3000/v1/config
```

`/health` отвечает `{"status":"ok"}` и проверяет HTTP-процесс; его использует
Docker HEALTHCHECK. `/ready` проверяет также RPC, полномочия и журнал, возвращает
`{"status":"ready"}` либо HTTP 503. Ошибки обязательных переменных, сети,
владельца или журнала при запуске завершают процесс с кодом 1 и `STARTUP_FAILED`.

## Настройки

| Переменная | По умолчанию | Значение |
|---|---|---|
| `PRIVATE_KEY` | обязательна | Ключ текущего владельца `OreVein` |
| `RPC_URL` | обязательна | HTTP(S) RPC Avalanche, в том числе Alchemy |
| `HOST` | `0.0.0.0` | Адрес внутри контейнера |
| `PORT` | `3000` | Порт внутри контейнера |
| `DATA_DIR` | `/app/data` в образе | Каталог журнала |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origin браузерного клиента через запятую |
| `POLL_INTERVAL_MS` | `3000` | Проверка транзакций, 100–60000 мс |
| `RPC_TIMEOUT_MS` | `20000` | Тайм-аут одного RPC-запроса, 1000–120000 мс |
| `PREVIEW_TTL_SECONDS` | `120` | Срок действия плана, 30–600 секунд |
| `LOG_BLOCK_RANGE` | `2000` | Начальный диапазон чтения событий; уменьшается при отказе RPC |
| `DEPLOYMENT_BLOCK` | из deployment-транзакции | Необязательный реальный блок развёртывания `OreVein` |

Готовый Compose передаёт ключ, RPC и `ALLOWED_ORIGINS`; дополнительные параметры
добавляются в его `environment`. `docker run --env-file` передаёт все строки файла.
При изменении внутреннего порта согласуйте публикацию порта.

Авторизации нет: это согласованный режим для одного защищённого устройства.
Проверка `Origin` для HTTP и WebSocket не является авторизацией. Запросы без
`Origin`, например из PowerShell, разрешены. Origin фронтенда задаётся со схемой
и портом, без завершающего `/`.

В общей Compose-сети фронтенд-сервер обращается к `http://admin-server:3000`.
Код в браузере обращается к опубликованному адресу `http://127.0.0.1:3000`
либо к настроенному вами reverse proxy.

## Заказ операции

1. `POST /v1/previews`: передать действие и общий бюджет газа `maxGasAvax`.
2. Показать пользователю `request`, `summary`, шаги и оценку газа.
3. После одного подтверждения отправить `POST /v1/operations` с `previewId` и новым UUID `requestId`.
4. Следить за результатом через REST или WebSocket. Отключение клиента работу не отменяет.

Предпросмотр ничего не подписывает и не отправляет. Пример PowerShell:

```powershell
$api = 'http://127.0.0.1:3000'
$body = @{
  action = @{
    kind = 'aave.supply'
    params = @{ token = 'USDC'; amount = '10' }
  }
  maxGasAvax = '0.05'
} | ConvertTo-Json -Depth 10

$preview = Invoke-RestMethod "$api/v1/previews" -Method Post -ContentType 'application/json' -Body $body
$preview | ConvertTo-Json -Depth 10

# После подтверждения пользователем отправляем весь план.
$requestId = [guid]::NewGuid().ToString()
$orderBody = @{ previewId = $preview.id; requestId = $requestId } | ConvertTo-Json
$operation = Invoke-RestMethod "$api/v1/operations" -Method Post -ContentType 'application/json' -Body $orderBody
Invoke-RestMethod "$api/v1/operations/$($operation.id)"
```

Новый заказ получает HTTP 202. Повтор того же `requestId` и `previewId` возвращает
ту же операцию с HTTP 200, в том числе после перезапуска. Это способ восстановиться
после потерянного HTTP-ответа. Другой preview с тем же request ID вызывает
`IDEMPOTENCY_CONFLICT`. Один preview нельзя выполнить повторно с новым request ID.

Суммы, цены и ID — строки. В запросах `amount: "10.5"` означает 10.5 токена;
экспоненты, запятые и отрицательные числа запрещены. В ответах денежные значения —
**целые строки в минимальных единицах**; decimals доступны в `/v1/config`.
Цены FreeMine в ответах всегда имеют 18 decimals. `maxGasAvax` задаётся в AVAX,
`maxGasWei` и `gasSpentWei` в ответах — в wei.

`expiresAt`, `createdAt`, `updatedAt` — Unix milliseconds. Контрактные времена
(`timestamp`, `deadline`, `fundedAt`, `priceUpdatedAt`) — Unix seconds.

### Виды действий

Ниже указаны `action.kind` и `action.params`. Все поля обязательны, кроме явно
отмеченных ниже; неизвестные поля отклоняются.

| `kind` | `params` | Назначение |
|---|---|---|
| `successor.schedule` | `{"address":"0x…","timestamp":1900000000}` | Назначить или перенести дату строго дальше в будущее |
| `successor.remove` | `{"address":"0x…"}` | Удалить преемника из расписания |
| `contract.setURI` | `{"uri":"ipfs://…"}` | Изменить `contractURI` |
| `fund.closeShift` | `{}` | Закрыть текущую смену |
| `fund.fundShift` | `{"price":"0.95"}` | Финансировать последнюю закрытую смену |
| `fund.expireClaim` | `{"shiftId":"1","claimId":"1"}` | Отменить невостребованную заявку после контрактного срока |
| `fund.updateEntryPrice` | `{"price":"1.01"}` | Изменить цену входа |
| `fund.changeDollar` | `{"token":"USDC"}` | Выбрать доллар из четырёх разрешённых токенов |
| `aave.supply` | `{"token":"USDC","amount":"10"}` | Внести вклад |
| `aave.withdraw` | `{"token":"USDC","amount":"10"}` | Вывести сумму; `"all"` — весь вклад |
| `aave.borrow` | `{"token":"USDC","amount":"1"}` | Занять по переменной ставке, mode 2 |
| `aave.repay` | `{"token":"USDC","amount":"1.1"}` | Погасить долг в пределах бюджета; `"all"` не поддерживается |
| `lfj.swap` | `{"tokenIn":"WAVAX","tokenOut":"USDC","amount":"1","slippageBps":40}` | Обмен exact input |
| `uniswap.mint` | см. пример | Создать позицию, при необходимости создать/инициализировать пул |
| `uniswap.increase` | `{"tokenId":"123","amount0":"1","amount1":"25","slippageBps":40}` | Добавить ликвидность в контрактном порядке token0/token1 |
| `uniswap.collect` | `{"tokenId":"123"}` | Забрать все комиссии и уже причитающиеся токены |
| `uniswap.close` | `{"tokenId":"123","slippageBps":40}` | Вывести всю ликвидность, собрать токены и сжечь NFT атомарно |

Создание позиции:

```json
{
  "action": {
    "kind": "uniswap.mint",
    "params": {
      "tokenA": "WAVAX", "tokenB": "USDC",
      "amountA": "1", "amountB": "25",
      "fee": 500, "range": "full", "slippageBps": 40
    }
  },
  "maxGasAvax": "0.1"
}
```

Для нового пула нужен `initialPrice`, например `"25"`: **tokenB за один tokenA
в человеческих единицах**. Для существующего инициализированного пула берётся
текущая цена. `fee` задаётся в миллионных долях: 100 = 0.01%, 500 = 0.05%,
3000 = 0.3%, 10000 = 1%; поддержка проверяется у factory.

Собственный диапазон: `range: "custom"` плюс `tickLower` и `tickUpper`.
Ticks соответствуют порядку token0/token1 после сортировки адресов, а не порядку
tokenA/tokenB; они должны быть кратны tick spacing. Суммы — верхние бюджеты.
Нулевая сумма одного токена разрешена для односторонней позиции вне текущей цены.

`slippageBps` — целое 0–1000; 40 означает 0.4%. LFJ перебирает простые маршруты
через разрешённые токены. План фиксирует минимальный выход обмена, а для Uniswap —
максимальные расходы и минимальные суммы. Закрывается собственная позиция;
общий пул Uniswap продолжает существовать. Частичный вывод пока не реализован.

## Шаги, газ и срок действия

Все заказы выполняются последовательно. Возможные шаги:

- `ALLOWANCE_RESET`: условный сброс недостаточного ненулевого разрешения;
- `ALLOWANCE_APPROVE`: условная выдача разрешения в пределах суммы операции;
- `EXECUTE`: основное действие.

Разрешения проверяются заново перед исполнением. Достаточный allowance приводит
к пропуску обоих условных шагов (`skipped`). Сервер сам выполняет остальные шаги
без дополнительных подтверждений. Перед каждой отправкой он симулирует вызов,
оценивает газ и добавляет 20% к gas limit.

Фактический расход газа предыдущих шагов плюс максимальная стоимость следующего
не должны превышать общий `maxGasAvax`. Этот бюджет не разрешает увеличить сумму
токенов или ухудшить согласованные ограничения проскальзывания.

До выдачи allowance финальный вызов не всегда можно симулировать. Тогда preview
имеет `gasEstimateComplete: false`, некоторые шаги — `requires_prior_steps`
и `maxGasWei: null`. `knownGasEstimateAvax` является только известной частью оценки.
Полная проверка финального вызова выполняется после разрешений. При её отказе
подтверждённые разрешения остаются в сети.

| Статус операции | Значение |
|---|---|
| `queued` | Принята и записана в журнал |
| `running` | Проверяется или подготавливается шаг |
| `waiting` | Ожидание receipt или доступности RPC |
| `needs_attention` | Конфликт nonce или истёкший неподтверждённый план |
| `succeeded` | Все шаги подтверждены либо пропущены |
| `failed` | Работа остановлена; причина в `error.code` |

Статусы шага: `pending`, `checking`, `signing`, `broadcasting`, `confirming`,
`confirmed`, `skipped`, `failed`. При `broadcasting` подпись уже записана в журнал;
хэш известен до ответа RPC. Receipt содержит блок, комиссию и логи, в том числе
NFT ID в событии `Transfer`. Позиции также доступны через читающий endpoint.

После истечения плана сервер не подписывает новые шаги и не обновляет котировку
автоматически. Изменение важного состояния, например номера смены, вызывает
`PLAN_CHANGED`. Для продолжения нужен новый preview и подтверждение.
Результат уже отправленной транзакции отслеживается и после истечения плана.

Ошибка операции не откатывает предыдущие транзакции. Смотрите статусы отдельных
шагов и receipts. Автоматического отзыва разрешений и общей отмены операции нет.

## WebSocket

Подключение: `ws://127.0.0.1:3000/v1/ws`. Канал только читает статусы; заказы
отправляются по REST. При подключении приходит до 100 последних операций:

```json
{"type":"operations.snapshot","operations":[]}
```

Изменения приходят полным объектом `operation` той же структуры, что HTTP GET:

```json
{"type":"operation.updated","operation":{"id":"…","version":3,"status":"waiting","steps":[]}}
```

Выше объект сокращён. Полный объект включает `request`, `summary`, временные
отметки, бюджет/расход газа и шаги. `version` монотонно растёт для каждой операции.

```js
const operations = new Map();
const socket = new WebSocket('ws://127.0.0.1:3000/v1/ws');
function accept(operation) {
  const previous = operations.get(operation.id);
  if (!previous || operation.version > previous.version) {
    operations.set(operation.id, operation);
    // Здесь обновляется интерфейс.
  }
}
socket.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'operations.snapshot') event.operations.forEach(accept);
  if (event.type === 'operation.updated') accept(event.operation);
};
```

Клиент переподключается с задержкой и получает новый снимок. Для более старой
операции используйте `GET /v1/operations/:id`. Каждая версия полностью описывает
состояние, воспроизводить все пропущенные события не нужно. Можно использовать
только периодический HTTP-опрос.

## Чтение данных

| Endpoint | Содержимое |
|---|---|
| `GET /health` | Жив ли процесс |
| `GET /ready` | RPC, полномочия и журнал |
| `GET /v1/config` | Сеть, адреса и токены без секретов |
| `GET /v1/balances` | AVAX владельца и OreVein, балансы четырёх ERC20 |
| `GET /v1/successors` | Расписание, номер и время блока |
| `GET /v1/fund` | Текущая смена, доллар, цены и допустимые границы |
| `GET /v1/fund/shifts/:id` | Финансирование смены и сроки отмены заявок |
| `GET /v1/fund/shifts/:id/claims?offset=0&limit=20` | Открытые заявки в диапазоне ID |
| `GET /v1/aave` | Залог, долг, health factor, вклады и переменные ставки |
| `GET /v1/uniswap/positions?offset=0&limit=20` | NFT позиций OreVein |
| `GET /v1/operations?offset=0&limit=20` | История заказов, новые первыми |
| `GET /v1/operations/:id` | Состояние одного заказа |

`limit`: 1–100; `offset`: 0–1000000. Для заявок обходятся ID от `offset + 1`
до `offset + limit`; закрытые пропускаются, поэтому страница может быть пустой
до конца `totalIds`. Номер текущей смены берётся из `/v1/fund`, прошлые читаются по ID.
Суммы Aave с суффиксом `Base` имеют 8 decimals, health factor — 18, ставки `Ray` — 27.
При отсутствии долга health factor равен `null`.

### Список преемников

Контракт не умеет перечислять адреса из `successors`. Сервер читает события
`SuccessorScheduled` с блока развёртывания, собирает адреса и проверяет значения
`successors(address)` на одном выбранном блоке. Нулевые значения отбрасываются,
остальные сортируются по времени. Проверяется согласованность хэша блока.

Адреса и курсор хранятся в памяти. Следующий запрос дочитывает новые события;
при реорганизации история восстанавливается. После перезапуска сканирование
начинается сначала, отдельная база индекса не нужна. Первый запрос может быть
дольше следующих. Недоступность истории RPC возвращает ошибку, а не пустой список.

Наступившая дата даёт право вызвать `claimPrivileges`, но не активирует
администратора автоматически. Такой преемник остаётся в календаре с `eligible: true`
до получения прав или удаления расписания.

## Восстановление после сбоя

`DATA_DIR/operations.json` содержит заказы, шаги, подписи и receipts, но не приватный
ключ. Файл обновляется через временный файл, `fsync` и atomic rename.
Подпись и хэш сохраняются **до** отправки в RPC.

При запуске с прежним volume и ключом сервер пропускает завершённые шаги,
проверяет receipts подписанных транзакций и при необходимости повторно отправляет
ту же подпись с тем же nonce и хэшем. Новая транзакция для такого шага не создаётся.
Оставшиеся шаги продолжаются, если план действителен и проверки проходят.

Если срок неподтверждённой транзакции истёк или nonce уже занят неизвестной
транзакцией, очередь ожидает в `needs_attention`. Сервер продолжает искать исходный
receipt и автоматически продолжит обработку при его появлении.

При внешней замене/отмене передайте хэш **уже подтверждённой** замены:

```http
POST /v1/operations/OPERATION_UUID/resolve
Content-Type: application/json

{"transactionHash":"0x…"}
```

Проверяются отправитель и nonce. Совпадающие получатель, calldata и value позволяют
принять receipt замены. Другой вызов завершает заказ ошибкой `TRANSACTION_REPLACED`,
его следующие шаги не исполняются, очередь освобождается. Этот endpoint сам не
подписывает замену и не повышает комиссию.

Потеря RPC-ответа после отправки не считается автоматической неудачей. До выяснения
результата не нужно создавать новый заказ: повторите запрос с прежним request ID
или читайте состояние существующего. Повреждённый журнал и журнал другого владельца
не игнорируются. Ошибка записи останавливает исполнителя, `/ready` возвращает 503.

## Ошибки

Формат: `{"error":{"code":"PLAN_EXPIRED"}}`. Контрактная ошибка может содержать
`reason`, например `EntryPriceUpdateTooEarly`; ошибка запроса — список `fields`.
Коды английские, локализация остаётся фронтенду. RPC URL, ключ и подписанные
raw-транзакции не возвращаются API и не печатаются в логах сервера.

Частые коды: `INVALID_REQUEST`, `PREVIEW_EXPIRED`, `PLAN_EXPIRED`, `PLAN_CHANGED`,
`GAS_BUDGET_EXCEEDED`, `INSUFFICIENT_TOKEN_BALANCE`, `INSUFFICIENT_GAS_BALANCE`,
`CONTRACT_REVERT`, `TRANSACTION_REVERTED`, `OWNER_MISMATCH`, `WRONG_NETWORK`,
`IDEMPOTENCY_CONFLICT`, `PREVIEW_ALREADY_SUBMITTED`.
Схемы: [src/requests](src/requests). Типы ответов: [src/operations/types.ts](src/operations/types.ts).

## Разработка и тесты

Стек: Node.js 24, TypeScript strict, Fastify, ethers v6, ws.

```sh
npm ci
npm run check
npm test
npm run build
```

Для локального запуска установите в `.env` `DATA_DIR=./data`:

```sh
node --env-file=.env dist/main.js
```

`npm run dev` наблюдает за исходниками и использует переменные процесса.
Запуск TypeScript с файлом окружения: `node --env-file=.env --import tsx src/main.ts`.

Интеграционная проверка использует настоящий Docker-образ и локальный форк.
В первом терминале:

```sh
node node_modules/hardhat/internal/cli/cli.js node --config scripts/hardhat.config.cjs --hostname 127.0.0.1 --port 18545
```

Во втором:

```sh
docker build -t ore-vein-admin-server:local .
npm run test:fork
```

Нужны Docker Desktop (`host.docker.internal`), свободные порты 18545 и 18080
и доступ к публичному RPC. Сценарий проверяет `hardhat_metadata` до записи,
создаёт одноразовые ключи только в форке, проверяет операции, WebSocket и
восстановление после `SIGKILL`. В конце удаляет собственные тестовые контейнер
и volume и восстанавливает snapshot. Реальная сеть не изменяется.
Для воспроизводимости в форке снимаются supply caps WAVAX/USDC и borrow cap USDC;
если все стандартные пулы заняты, добавляется тестовый fee tier. Рабочий сервер
эти параметры протоколов не меняет: их ограничения возвращаются как контрактные ошибки.
Перед HTTP-сценарием тест прогревает состояние LFJ; на публичном RPC это может занять несколько минут.

При HTTP 429 от публичного RPC можно использовать ограничивающий частоту прокси.
Запустите `node scripts/fork-rpc-proxy.mjs` в отдельном терминале, затем перед
запуском Hardhat задайте в PowerShell:

```powershell
$env:FORK_RPC_URL = 'http://127.0.0.1:18546'
```

Прокси разрешает только чтение и ограничивает параллельность тремя запросами
к публичному Avalanche RPC. Его основной источник можно переопределить через
`FORK_UPSTREAM_URL`; при тайм-ауте альтернативного источника используется публичный
Avalanche RPC. Альтернативный RPC для форка задаётся переменной
переменной `FORK_RPC_URL` и не меняет рабочую конфигурацию сервера.

Тесты без сети проверяют денежную точность, сравнение TickMath с официальным SDK,
идемпотентность, потерю ответа, восстановление, сбои записи и HTTP/WebSocket.
SDK и Hardhat — dev-зависимости и в рабочий образ не входят.

Публичные интерфейсы модулей находятся в `index.ts`, типы — в отдельных файлах.
`chain` отвечает за RPC/подпись, `protocols`, `fund`, `successors` — за предметные
операции, `operations` — за планы/журнал/очередь, `http` — за транспорт.
Новое действие добавляется через схему, построитель плана и диспетчер предпросмотра;
исполнитель и WebSocket используют общую модель шагов. Комментарии — на русском.
Старый CLI сохранён в `old/` как справочный материал.

Документация: [ethers](https://docs.ethers.org/v6/api/providers/),
[Fastify](https://fastify.dev/docs/latest/Reference/Server/), [ws](https://github.com/websockets/ws).
