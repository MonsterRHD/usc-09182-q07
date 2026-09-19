# 泥塑干燥烧制追踪

为浚县非遗泥塑产业提供的干燥与烧制过程追踪服务：把**泥料来源、成型时间、阴干环境（含含水率）、窑炉批次、温度曲线摘要、出窑检查**关联到单件或批次，并在批次拆分、窑炉中断、补烧、判废、样品抽检之间保持连续谱系。

## 设计要点

- **事件溯源（append-only）**：所有状态变更都是不可变事件，落盘到 `data/events.jsonl`（可用 `DATA_FILE` 覆盖）。进程重启后重放事件即可恢复——重新部署后未出窑的窑次可继续烧制。
- **结论不被读数覆盖**：放行 / 判废 / 抽检结论一旦采纳即固定；出窑后迟到的传感器读数只追加记录，不再触发冻结或推翻结论。冻结期间的迟到读数也不会自动解冻。
- **消息幂等**：设备曲线读数携带 `messageId`，相同消息重传返回首次结果，不产生重复事件。
- **倒序上传容忍**：读数按自身时间戳归并排序，曲线摘要（起止、极值、温变速率）不受上传顺序影响。
- **异常曲线冻结 + 通知**：曲线缺口（如停电停发 >30 分钟）、温变速率超限（>20℃/min）、温度越限（<0℃ 或 >1400℃）会冻结当前窑次内全部批次，并按作坊责任人挂通知；责任人核查留痕后可解冻。
- **连续谱系**：母批拆成子批后仍可双向追溯；补烧是新窑次但与原件同一条谱系，`trace` 给出完整烧制历史（含中断、异常标记、曲线摘要）。

## 运行

```bash
npm start                 # 默认 0.0.0.0:3000，数据文件 data/events.jsonl
PORT=8080 npm start
DATA_FILE=/var/lib/kiln/events.jsonl npm start
npm test                  # node:test，共 10 个用例
```

零依赖，仅使用 Node.js 内置模块（需 Node 18+）。

## HTTP 接口

| 动作 | 方法与路径 | 关键字段 |
|---|---|---|
| 登记单件/批次 | `POST /api/units` | `kind`(item/batch)、`name`、`claySource`、`formedAt`、`workshop`、`dryingEnv`、`moisture` |
| 补录干燥环境 | `POST /api/units/:id/drying` | `env`、`moisture` |
| 批次拆分 | `POST /api/batches/:id/split` | `parts:[{qty,note,batchId?}]` |
| 入炉开窑次 | `POST /api/kilns/:kilnId/firings` | `itemIds`、`plannedCurve`、`firingId?` |
| 中断（停电）/ 恢复 | `POST /api/kilns/:k/firings/:f/interrupt`、`/resume` | `reason` |
| 上报曲线读数 | `POST /api/kilns/:k/firings/:f/readings` | `messageId`、`ts`、`temp` |
| 责任人解冻 | `POST /api/kilns/:k/firings/:f/unfreeze` | `reason`、`resumed` |
| 出窑 | `POST /api/kilns/:k/firings/:f/unload` | — |
| 出窑检查 | `POST /api/units/:id/inspect` | `result`: released / refire / scrap，`cracks`、`note`、`inspector` |
| 样品抽检 | `POST /api/batches/:id/sample-check` | `sampleSize`、`defectCount`（缺陷率 >5% 判不通过） |
| 单件/批次追溯 | `GET /api/units/:id/trace` | — |
| 月末核账 | `GET /api/report?workshop=xx` | 放行、判废、待补烧、冻结、开裂合计、损耗明细、抽检、冻结通知 |
| 冻结通知 | `GET /api/notifications` | — |
| 健康检查 | `GET /health` | 返回当前事件版本 |

## 典型流程（月末核账场景）

1. 登记母批（泥料 C03、成型时间、甲作坊、阴干环境、含水率）；
2. 拆批为两个子批，分别装入 K1、K2；
3. K1 倒序上传正常曲线 → 出窑 → 一批放行、一件口沿开裂判废；
4. K2 烧制中停电（中断事件 + 曲线缺口）→ 恢复后首条读数触发冻结并通知甲作坊；
5. 责任人核查解冻 → 出窑 → 判补烧 → K3 补烧 → 复检放行；
6. `GET /api/report?workshop=甲作坊` 核对放行数、判废损耗、开裂合计与冻结记录。

完整场景见 `test/domain.test.mjs` 首个用例。

## 目录

- `src/store.mjs`：JSONL 仅追加事件存储（重放恢复）
- `src/domain.mjs`：命令处理、状态投影、曲线异常判定、谱系追溯、核账报表
- `src/server.mjs`：HTTP 路由与 JSON 序列化
- `test/`：领域全链路、幂等、异常冻结、重部署续烧（真实 HTTP + 临时数据文件）
