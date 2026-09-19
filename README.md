# 泥塑干燥烧制追踪服务

为浚县泥咕咕类非遗作坊提供泥坯从泥料来源到出窑放行的全链路追踪。核心采用**事件溯源（append-only 日志）**：
所有操作只追加事件，结论（曲线摘要、检验、放行、判废）一经采纳即定稿，后到的传感器读数不会覆盖它们。

## 启动

```bash
npm start          # 默认 :3000，事件存于 ./data
PORT=3001 DATA_DIR=/var/lib/kiln npm start
npm test           # 13 个场景测试
```

## 设计原则

- **连续谱系**：批次拆分（`split`）、入窑（`fired_in`）、窑炉中断/恢复、补烧（`refire`）、检验（`inspected`）、
  放行/判废/冻结均为谱系边，`GET /v1/lineage/:id` 可从任一节点查全链。
- **读数与结论分离**：读数只追加且保留设备原始时间（支持倒序上传）；曲线摘要采纳后不可改写。
  同一 `readingId` 重传完全幂等；同号不同内容返回 `409 READING_CONFLICT`。
- **异常冻结**：采纳异常曲线摘要（超温/超速/偏差超限或显式 abnormal）自动冻结同炉相关批次并向责任人发通知，
  冻结期间除解冻与登记中断外的命令一律 `409 BATCH_FROZEN`。
- **重新部署续烧**：重启时重放 `data/events.log`，未出窑的 running/interrupted 窑批自动恢复，可继续操作。
- **命令幂等**：请求头 `Idempotency-Key`（或正文 `idempotencyKey`）相同的命令重放只生效一次。

## 命令接口

`POST /v1/commands`，正文 `{"type": "...", "payload": {...}}`，成功返回 `201`（幂等重放返回 `200`）。

| type | 关键字段 |
|---|---|
| `batch.register` | claySource, workshop, formedAt, owner, unitIds |
| `batch.drying_start` | batchId, workshop |
| `batch.split` | fromBatchId, splits[{batchId, unitIds, workshop?, owner?}]（单件必须穷尽、不得重复分配） |
| `device.register` | deviceId, kilnId |
| `reading.ingest` | deviceId, readingId, kind=`kiln`/`environment`, kilnBatchId/batchId, at, temp, humidity |
| `kiln_batch.start` | kilnBatchId, kilnId, batchIds, plannedCurve |
| `kiln_batch.interrupt` / `kiln_batch.resume` / `kiln_batch.complete` | kilnBatchId |
| `kiln_batch.refire` | fromKilnBatchId, toKilnBatchId, batchIds?, reason |
| `curve.summary_adopt` | kilnBatchId, maxTemp, rampPerHourMax, targetDeviationMax, abnormal…（异常即冻结+通知） |
| `inspection.record` | batchId, unitId?, inspectType=`exit`/`sample`/`refire_check`/`drying`, result=`pass`/`fail`/`conditional` |
| `batch.release` | batchId（须 fired 且最近一次出窑/抽检为 pass） |
| `batch.condemn` | batchId, reason |
| `batch.unfreeze` | batchIds 或 kilnBatchId, reason, by |

## 查询接口

- `GET /v1/batches` / `GET /v1/batches/:id`
- `GET /v1/kiln-batches/:id`（含读数与已采纳摘要）
- `GET /v1/lineage/:id`（批次或窑批为根的节点+边）
- `GET /v1/reports/loss`（月末核账：按件统计在制/放行/判废，拆分父批不重复计件）
- `GET /v1/notices`、`GET /v1/events`、`GET /health`

## 目录

```
src/domain.mjs   事件投影、异常判定、谱系构建、核账视图（纯逻辑）
src/store.mjs    append-only 事件日志与重放
src/handlers.mjs 命令校验、幂等、冻结规则
src/app.mjs      HTTP 路由
src/server.mjs   入口与责任人通知落盘（data/notices.log）
test/            生命周期、读数幂等/倒序、冻结通知、重启续烧、补烧、抽检场景
```

敏感配置请放在本地环境文件中。
