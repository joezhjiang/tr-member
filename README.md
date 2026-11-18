# tr-member · 会员系统后端

一套可直接运行的会员系统后端服务：会员档案、等级与权益、订阅/续费/退订、积分与成长值、订单支付与退款，全部通过 REST 接口暴露。

- 运行时：Node.js ≥ 20（开发使用 Node 22），**零运行时依赖**，只用标准库
- 存储：进程内存储 + 可选 JSON 快照落盘（重启可恢复）
- 测试：Node 内置 `node:test`，40 个用例覆盖领域规则与接口行为

## 快速开始

```bash
npm start                 # 默认监听 3000，纯内存模式
DATA_FILE=./data/db.json npm start   # 开启 JSON 快照持久化

npm test                  # 运行全部测试
npm run test:coverage     # 查看覆盖率
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DATA_FILE` | 空（内存模式） | JSON 快照路径，为空则仅存内存 |
| `ADMIN_TOKEN` | `dev-admin-token` | 管理端令牌，生产必须覆盖 |

## 目录结构

```
src/
  core/        错误类型、id/token 生成、参数校验
  domain/      等级规则、时间计算、默认等级/权益/套餐目录（纯函数）
  store/       内存存储 + JSON 快照
  services/    会员、目录、订阅、订单、积分、权益、维护任务
  http/        极简路由、请求处理、接口定义
  app.js       依赖装配（now 可注入，便于测试推进时间）
  server.js    进程入口
tests/         领域单测 + 接口集成测试 + 持久化测试
```

分层原则：`domain` 纯函数不依赖存储；`services` 承载业务规则并保证一次操作内的读写一致；`http` 只做协议转换、鉴权与错误映射。

## 鉴权

- 会员注册成功后返回一次性 `token`，之后用 `Authorization: Bearer <token>` 访问本人资源；令牌在库里只存 SHA-256 哈希，可调用 `POST /api/members/:id/token/rotate` 轮换。
- 管理端接口使用请求头 `x-admin-token: <ADMIN_TOKEN>`。
- 会员态接口允许「本人」或「管理员」访问，越权返回 `403 FORBIDDEN`；未携带有效令牌返回 `401 UNAUTHORIZED`。

## 核心业务规则

**等级（tier）**

- 成长值等级：取 `growthThreshold <= growth` 的最高等级（free 0 / silver 500 / gold 2000 / platinum 8000）。
- 付费等级：有效订阅（`status=active` 且未到期）中等级最高者。
- 实际生效等级取二者更高者，响应中的 `tier.source` 标明来源（`growth` / `subscription`）；订阅到期或退订后自动回落到成长值等级。

**订阅（subscription）**

- 下单 → 支付成功才落订阅，`startAt/endAt` 按套餐月数计算（月末自动收敛，如 1/31 + 1 月 = 2/28）。
- 同套餐仍有有效期时再次购买 = 顺延到期时间（`action=extended`），不会重复建订阅。
- 不同套餐可并存，会员等级取最高，`GET /api/members/:id/subscriptions` 可查全部。
- 退订立即生效：订阅置为 `cancelled`，该订阅发放的权益同步回收。

**权益（benefits）**

- 等级 → 权益配额由 `benefitRules` 定义，`monthly` 按自然月发放（`periodKey=YYYY-MM`，月末失效），`lifetime` 每个会员只发一次且不随订阅到期回收。
- 同一自然月内升级只补配额差额（例如白银 4 次 → 黄金 10 次，已用 4 次则剩余 6 次），不重复发放。
- 使用权益时先消耗月度额度、再消耗终身额度；超额返回 `409 BENEFIT_EXHAUSTED`，当前等级不含该权益返回 `403 BENEFIT_NOT_AVAILABLE`。

**积分（points）与成长值（growth）**

- 支付成功按套餐发放成长值与赠送积分；积分流水的 `balanceAfter` 与该次操作后的余额一致。
- `earn` / `spend` 支持 `idempotencyKey`：同键同参数重复调用返回原流水（`idempotent=true`），同键不同参数返回 `409 IDEMPOTENCY_CONFLICT`。
- 余额不足返回 `409 INSUFFICIENT_POINTS`，余额不会为负。

**退款（refund）**

- 仅管理员可对已支付订单退款：订单置 `refunded`，关联订阅取消，该订阅发放的权益回收。
- 成长值按订单记录回滚；赠送积分按订单记录回收，最多扣到 0，不产生负余额。
- 退款为幂等防线：重复退款返回 `409 ORDER_NOT_REFUNDABLE`。

**自动续费与定时任务**

`POST /api/admin/maintenance/run`（建议 cron 每分钟调用）依次执行：

1. 过期权益置为 `expired`；
2. 到期订阅：开启 `autoRenew` 且套餐在架、会员正常时，生成 `kind=renewal` 订单并自动支付、顺延到期时间；否则置为 `expired`；
3. 为在期会员补发当月权益（跨月自动刷新）。

返回各项处理数量与续费订单 id，便于对账。

## 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| GET | `/api/tiers` | 公开 | 等级与各等级权益配额 |
| GET | `/api/plans` | 公开 | 套餐列表（`?includeInactive=true` 含下架） |
| GET | `/api/benefits` | 公开 | 权益定义 |
| POST | `/api/members` | 公开 | 注册会员，返回 `member` + `token` |
| GET | `/api/members/:id` | 本人/管理员 | 会员档案（等级、成长值、积分、当前订阅） |
| POST | `/api/members/:id/token/rotate` | 本人/管理员 | 轮换访问令牌 |
| GET | `/api/members/:id/subscriptions` | 本人/管理员 | 订阅列表 |
| GET | `/api/members/:id/benefits` | 本人/管理员 | 当前权益与剩余额度 |
| POST | `/api/members/:id/benefits/:code/consume` | 本人/管理员 | 使用权益 `{quantity}` |
| GET | `/api/members/:id/points` | 本人/管理员 | 积分余额与流水 |
| POST | `/api/members/:id/points/earn` | 本人/管理员 | 获取积分 `{amount, reason?, idempotencyKey?}` |
| POST | `/api/members/:id/points/spend` | 本人/管理员 | 消耗积分，同上 |
| GET | `/api/members/:id/orders` | 本人/管理员 | 订单列表 |
| POST | `/api/members/:id/orders` | 本人/管理员 | 下单 `{planId, autoRenew?}` |
| GET | `/api/orders/:id` | 本人/管理员 | 订单详情 |
| POST | `/api/orders/:id/pay` | 本人/管理员 | 支付确认（幂等） |
| POST | `/api/orders/:id/cancel` | 本人/管理员 | 取消待支付订单 |
| POST | `/api/subscriptions/:id/cancel` | 本人/管理员 | 退订 `{reason?}` |
| GET | `/api/admin/members` | 管理员 | 会员列表 `?status=&limit=&offset=` |
| PATCH | `/api/admin/members/:id` | 管理员 | 修改状态 `{status: active\|frozen\|cancelled}` |
| POST | `/api/admin/orders/:id/refund` | 管理员 | 退款 `{reason?}` |
| PUT | `/api/admin/tiers/:code/benefits` | 管理员 | 覆盖某等级权益 `{benefits:[{benefitCode, quota, period}]}` |
| POST | `/api/admin/plans` | 管理员 | 新建套餐 |
| PATCH | `/api/admin/plans/:id` | 管理员 | 修改套餐（价格、成长值、上下架等） |
| POST | `/api/admin/maintenance/run` | 管理员 | 执行到期清理、自动续费、权益刷新 |

错误响应统一为：

```json
{ "error": { "code": "BENEFIT_EXHAUSTED", "message": "权益额度不足", "details": { "remaining": 0 }, "requestId": "req_..." } }
```

常用错误码：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN` / `MEMBER_FROZEN` / `BENEFIT_NOT_AVAILABLE`(403)、`NOT_FOUND`(404)、`INSUFFICIENT_POINTS` / `BENEFIT_EXHAUSTED` / `ORDER_NOT_PAYABLE` / `ORDER_NOT_REFUNDABLE` / `SUBSCRIPTION_NOT_ACTIVE` / `IDEMPOTENCY_CONFLICT`(409)。

## 示例

```bash
# 1. 注册
curl -s -X POST localhost:3000/api/members \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice"}'
# => { "member": {...}, "token": "xxxx" }

# 2. 下单并支付（黄金年卡，开启自动续费）
curl -s -X POST localhost:3000/api/members/$MEMBER_ID/orders \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"planId":"plan_gold_yearly","autoRenew":true}'

curl -s -X POST localhost:3000/api/orders/$ORDER_ID/pay \
  -H "authorization: Bearer $TOKEN"

# 3. 查看权益与使用
curl -s localhost:3000/api/members/$MEMBER_ID/benefits -H "authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/api/members/$MEMBER_ID/benefits/free_shipping/consume \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"quantity":2}'

# 4. 管理端触发定时任务
curl -s -X POST localhost:3000/api/admin/maintenance/run -H "x-admin-token: $ADMIN_TOKEN"
```

## 测试

```bash
npm test
```

覆盖：等级判定与月末时间计算、注册与鉴权/越权、下单支付幂等、续费顺延、多套餐并存、权益发放/消耗/同月升级补差/跨月刷新、积分幂等与余额保护、退订与退款回滚、自动续费与过期、JSON 持久化恢复。

CI 配置见 `ci/github-actions-ci.yml`（Node 20 / 22 跑 `npm test`）。复制到 `.github/workflows/ci.yml` 即可启用；推送该目录需要仓库令牌具备 `workflow` 权限。

## 已知边界

- 存储为单进程内存 + JSON 快照，适合单实例部署；多实例或高并发需要替换为关系型/KV 数据库，并把幂等键改为数据库唯一约束。
- 支付为同步模拟（`/pay` 即视为支付成功），接入真实支付渠道时应改为异步回调 + 签名校验，并在回调里复用 `pay()` 的幂等语义。
- 套餐数量、等级门槛目前通过管理端接口调整；等级门槛修改没有历史审计，生产建议加配置变更审计表。
- 权益按 UTC 自然月发放，若业务按东八区月切分，需要把 `domain/time.js` 的月份计算改为业务时区。
