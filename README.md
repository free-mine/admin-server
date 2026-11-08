# OreVein Admin Server

Backend панели владельца Free Mine для Avalanche C-Chain (chainId 43114).
Сервер готовит план операции, после подтверждения подписывает и последовательно
выполняет транзакции, сохраняет журнал и отдаёт статусы через REST и WebSocket.
Поддерживаются управление OreVein/FreeMine, преемники, Aave, LFJ и Uniswap V3.
Капитал и NFT позиций остаются у OreVein, газ оплачивает кошелёк владельца.

Docker-образ: **`ghcr.io/free-mine/admin-server`**. GitHub Actions собирает
и публикует его при обновлении `main`.

Техническую документацию читайте в [Swagger UI](https://free-mine.github.io/admin-server/):
начните с общего описания форматов и порядка работы, затем смотрите параметры,
примеры и ответы нужного endpoint. WebSocket описан в `/v1/ws`.
[swagger/openapi.yml](swagger/openapi.yml) — та же спецификация для редакторов
OpenAPI и генераторов клиентов; Pages показывает версию из `main`.

Настройки запуска: [.env.example](.env.example) и
[src/config/environment.ts](src/config/environment.ts). Сервер рассчитан на локальный
доступ без авторизации: один экземпляр на кошелёк, постоянный volume для `/app/data`.
Для запросов из Swagger UI добавьте `https://free-mine.github.io` в `ALLOWED_ORIGINS`;
адрес своего API укажите в поле `Servers`.

Для разработки нужен Node.js 24.13.1: `npm ci`, затем `npm run lint`,
`npm run format:check`, `npm run check`, `npm test` и `npm run build`.
Эти проверки выполняются для каждого PR; Swagger публикуется на Pages из `main`.
