# DSH Plan · 赤石额度管理器

> 赤石科技出品。  
> DeepSeek 官方并未提供 Plan 订阅。但借助本插件，你依然能随时体验到额度告急、工作被迫中止的平静与绝望。

---

## 项目背景

许多习惯了月费订阅制大模型的开发者，在转向 DeepSeek API 时常常会产生一种轻微的心理失调：

API 始终按 token 实收实付，便宜且稳定。这意味着你很难再体会到那种在代码调到最关键时刻、思路正盛时，突然弹出一句「已达到使用上限，请于数小时后重试」的突兀感。你失去了每隔几个小时就盯着重置倒计时陷入沉默的机会，也失去了以此为由合上电脑去散步的正当借口。

缺乏这种周期性的受挫体验，现代开发工作往往会变得过于漫长且难以收场。

赤石科技认为，没有订阅，不代表我们不能主动制造同等的危机感。

`dsh-quota-plan` 是为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 设计的额度限制与用量管理插件。它不改变模型的推理质量，只负责在本地严谨地统计你的开销，并在预设额度耗尽时，平静、冷酷地阻断后续调用。

**我们没有订阅，但为你如实还原了订阅耗尽后的生活。**

---

## 核心特性

- **确定的物理阻断**  
  这不是用于自我感动的轻度弹窗提醒。一旦 5 小时窗口或 7 天窗口超出预设预算，插件会在底层拦截所有经由 `llm/stream` 发往模型的请求。未改完的代码只能留在编辑器里，你有充足的时间在工位上平复情绪。

- **含蓄的百分比界面**  
  仪表盘不展示你具体消耗了多少美元或美分，仅提供两条模仿主流订阅产品的百分比进度条。80% 时提示额度见底，95% 时亮起预警。我们相信，模糊的百分比远比具体的数字更能引发恰到好处的焦虑。

- **按本次请求预留**
  默认根据本次 DSH 请求估算输入，并按同一服务和模型的近期用量估算输出，预留本次费用。历史不足时默认按 2048 个输出 tokens 预留，实际输出长度由 DSH 和模型决定。设置中仍可选择按模型最大上下文容量预留输入的严格模式。自动价格采用标准档内已公布的最高上下文或缓存 TTL 费率；DeepSeek 使用高峰价。

- **连坐机制与持久化账本**  
  主会话、子代理、上下文压缩以及标题生成均共用同一套额度。任何一个环节的开销都会同等地推高整体百分比。关掉浏览器窗口或重启程序不会重置状态；账本保存在本地磁盘并附带文件锁，记录足够清醒。

---

## 默认规则

| 窗口 | 后台预算 | 重置机制 |
| :--- | :--- | :--- |
| **5 小时窗口** | 4.00 美元 | 自首次获准的请求起计时，满 5 小时后释放该窗口已用额度 |
| **7 天窗口** | 20.00 美元 | 自首次获准的请求起计时，满 7 天后释放该窗口已用额度 |

- 两个窗口独立计时、并行校验。任一窗口预算不足，新的调用即告终止。
- 默认使用本次请求估算（`reservationMode: "request"`），输入安全倍率为 `1.25`；严格模式可选 `"context"`。既有配置未指定模式时自动采用 `"request"`，已有的 `inputTokenMultiplier` 设置继续保留。
- 输出预留参考近期完成请求；历史不足时使用 `outputReservationTokens`，默认 `2048`。插件不添加、裁剪或修改请求的输出上限。
- 倒计时统一按**北京时间 (UTC+8)** 显示。
- 主界面的使用比例同时包含已结算费用与正在进行的预留金额。

---

## 安装说明

### 环境要求
- 官方 DeepSeek Harness (`DSH >= 0.2.0-rc.2`)
- Node.js `22.19+` 或 `24+`（原生 ESM，无需预编译）

### 本地载入
将命令中的路径替换为你本地的实际绝对路径：

**Windows (PowerShell):**
```powershell
dsh plugin --profile web add "E:\ds赤石科技"
dsh web
```

**Linux / WSL (Bash):**
```bash
dsh plugin --profile web add "/mnt/e/ds赤石科技"
dsh web
```

> 若 DSH 已经在运行，需先结束旧进程重新启动，并刷新浏览器界面。如果安装至其他 profile，请将命令中的 `web` 替换为对应 profile 名称。

### 访问界面
启动后可在 DSH 内打开 **设置 → Plan 额度**，或直接在浏览器访问内置 GUI：
```text
http://127.0.0.1:3080/_dsh/quota-plan/
```
*(自定义端口时请使用实际端口号)*

---

## 预算与拦截机制

默认的本次请求模式会根据 DSH 当前请求中的消息、系统提示、工具描述与参数估算输入。文本采用无需新增依赖的启发式估算：ASCII 文本约每 4 个字符计 1 token，非 ASCII 文本每个 Unicode 字符计 1 token，再计入消息、内容块与工具定义的结构开销，最后乘输入安全倍率。请求送达模型前，插件会预留以下费用：

```text
输入预留 = 本次输入 token 估算 × 安全倍率 (默认 1.25) × 最高输入单价
输出预留 = 本次估算输出 tokens × 输出单价
单次请求预留 = 输入预留 + 输出预留
```

DSH 支持工具历史投影时，插件按该能力处理工具变更后的模型可见消息和定义，避免遗漏历史工具内容；旧版 SDK 则保守计入历史工具定义。图片使用模型路由提供的视觉 token 数与附带文本估算，文件使用模型可见的文件句柄文本估算。

本次输入估算不需要模型声明上下文容量。仅在相关接口不可用或输入无法估算时，才回退到按模型最大上下文容量预留；两者都不可用才拒绝。选择严格模式（`reservationMode: "context"`）时，始终按模型最大上下文容量乘安全倍率预留输入费用，并要求模型提供上下文容量。`request` / `context` 选项仅影响输入预留。

输出估算从账本保留的最近 50 条结算记录中，选取相同 `provider/model`、状态为 `completed` 且带有效 token 用量的最近最多 20 条记录。至少有 5 条样本时，使用输出 tokens 的第 90 百分位数（P90）乘 `1.25`，向上取整，并至少预留 `256` tokens；不足 5 条时使用设置中的 **无历史时输出预留 tokens**（`outputReservationTokens`，默认 `2048`）。失败或按预留估算结算的请求不参与历史学习。

若原请求已有更小的有效 `maxTokens`，只将输出预留缩小到该值。插件不修改 `maxTokens`，也不要求请求必须携带该字段；实际输出长度继续由 DSH、请求本身与模型决定。

旧配置会自动迁移：旧字段 `maxOutputTokens` 为 `8192` 时改用新的默认预留 `2048`；其他旧值保留为历史不足时的输出预留。已有 `outputReservationTokens` 时以新字段为准。迁移后不再保留插件自身的输出上限，历史用量继续保留。

1. **准入检查**：在同一账本锁内检查剩余额度并记录本次预留，避免并发请求重复占用余额。若当前可用额度小于本次预留金额，系统将拒绝调用，所以进度条未到 100% 也可能无法容纳下一次请求。
2. **正常结算**：请求结束并返回有效用量后，按实际消耗（普通输入、缓存命中、缓存写入、输出）扣费，并释放多余预留。
3. **异常处理**：若已进入提供商调用，但请求中断、异常或结束时没有返回用量计数，系统按本次估算预留结算。这只是本地估算，可能与实际收费不同；默认模式按本次输入估算，严格模式按上下文容量估算输入，两者均使用上述输出预留策略。若用量计数无效或账本写入失败，则保留预留并暂时阻止新调用；下次请求前重试结算，成功后解除对应失败状态。

输入估算不是精确 tokenizer，历史输出也不能预测本次实际长度，因此预留不是实际用量的绝对上界，不能保证费用硬上限；预留时不预测缓存命中。有效用量超出预留时仍完整记账，不因超出预留截断当前输出，窗口预算耗尽后阻断后续请求。未知价格和损坏账本仍会拦截，避免在无法可靠计费时继续调用。

---

## 模型单价配置

插件支持从官方公开价格 API、Markdown/MDX 文档和价格网页同步模型单价。GUI 的自动定价面板提供开关、**立即同步**、来源状态、**DSH 服务 → 价格来源**绑定，以及可选的人民币汇率设置。

单价采用以下优先级：

```text
手动配置 > 有效的自动同步价格 > 内置参考价
```

自动价格只用于显式绑定的 DSH provider，不根据模型名称或接口地址猜测调用渠道。默认仅绑定 `deepseek-official → deepseek`；其他官方服务、云平台和第三方渠道均需在 GUI 中指定对应来源。相同模型在不同渠道的价格不能互相代用。

### 已支持的公开来源

| 价格来源 | 来源 ID | 获取方式与范围 |
| :--- | :--- | :--- |
| [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) | `deepseek` | 官方 HTML 价表，按高峰价核算 |
| [OpenAI](https://developers.openai.com/api/docs/pricing.md) | `openai` | 官方 Markdown，Standard token 价格 |
| [Claude](https://platform.claude.com/docs/en/about-claude/pricing.md) | `anthropic` | 官方 Markdown，普通 API 与缓存 TTL 价格 |
| [Gemini Developer API](https://ai.google.dev/gemini-api/docs/pricing?hl=en) | `google` | 官方 HTML，标准付费档价格 |
| [Mistral](https://docs.mistral.ai/inference/pricing.md) | `mistral` | 官方 Markdown，包含 API 模型名 |
| [Kimi](https://platform.kimi.com/docs/pricing/chat.md) | `kimi` | 官方 MDX 静态表格，人民币价格 |
| [智谱 BigModel](https://docs.bigmodel.cn/cn/guide/start/pricing.md) | `bigmodel` | 官方 Markdown，人民币价格 |
| [Z.AI](https://docs.z.ai/guides/overview/pricing.md) | `zai` | 官方 Markdown，美元价格 |
| [MiniMax 中国站](https://platform.minimax.cn/docs/guides/pricing-paygo.md) | `minimax-cn` | 官方 Markdown，人民币 Standard 按量价格 |
| [MiniMax 国际站](https://platform.minimax.io/docs/guides/pricing-paygo.md) | `minimax` | 官方 Markdown，美元 Standard 按量价格 |
| [硅基流动中国站](https://www.siliconflow.cn/pricing) | `siliconflow-cn` | 官方网页内嵌 JSON，人民币渠道价格 |
| [SiliconFlow 国际站](https://www.siliconflow.com/pricing) | `siliconflow` | 官方网页内嵌价格数据，美元渠道价格 |
| [OpenRouter](https://openrouter.ai/api/v1/models) | `openrouter` | 公开 JSON 模型价格 API，聚合渠道价格 |
| [Azure OpenAI](https://prices.azure.com/api/retail/prices) | `azure` | 公开 Retail Prices API，目前限 `eastus2` |
| [AWS Bedrock](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json) | `bedrock` | 官方公开 JSON 价表，目前限 `us-east-1` |
| [Cohere](https://docs.cohere.com/docs/command-a) | `cohere` | 官方型号文档，目前覆盖 Command A、Command R、Command R+ |

以上是 16 个价格来源，不代表覆盖这些平台的全部模型和计费项目。价格同步选择普通按量档；同一标准模型有多个上下文、输出长度或缓存 TTL 档位时，按各字段最高单价保守计算。Batch、Fast、Ultrafast 和 Priority 档位不混入普通价格。按小时计费的缓存存储、工具调用、图片、视频及地域附加费不计入这四项 token 单价，相关限制会保留在来源备注中。

Azure 和 Bedrock 的目录型号带有 `@地域/部署类型` 等范围。先绑定对应价格来源，再从 GUI 的目录中复制与实际部署一致的完整型号，在选填的 **请求模型 ID → 目录型号**中，将完整的 `provider/model` 映射到该条目。目录键必须精确匹配，不能根据基础模型名套用其他地域或部署类型；无法对应时请填写手动单价。Claude 旧型号若无法确认 API ID，会保留官方显示名，不猜测日期快照。

`xai`、`bailian`、`volcengine` 和 `gcp` 目前仅保留扩展状态，尚未接入需要凭据的价格接口。

### 同步与币种

- 默认每 **24 小时**刷新一次，可在 GUI 中立即同步。同步失败时保留上次成功的快照；快照超过默认 **7 天**有效期后，不再用于自动计价。
- 窗口预算与账本统一使用美元。人民币来源需手动填写 **1 USD = 多少 CNY**；未设置汇率时，该来源的价格可以同步，但不能用于美元记账。插件不自动获取或更新汇率。
- 同步器只读取公开来源，不需要上传提示词或 API 密钥。网页结构或计费规则变化时可能停止提取，来源状态会显示失败原因。
- 自动同步是本地额度估算，不是官方账单查询，也不保证与账户折扣、税费或最终账单完全一致。

以下为账本中的自动定价配置字段；开关、汇率、来源绑定和型号映射可在 GUI 中设置：

| 配置字段 | 作用 |
| :--- | :--- |
| `autoPricingEnabled` | 启用或停用自动定价 |
| `pricingRefreshHours` | 刷新间隔，默认 `24` 小时 |
| `pricingMaxAgeHours` | 自动价格最大有效期，默认 `168` 小时 |
| `pricingCnyPerUsd` | 可选的人民币汇率，表示 `1 USD = N CNY` |
| `pricingRoutes` | DSH provider → 来源 ID 的对象映射，默认 `{"deepseek-official":"deepseek"}` |
| `pricingModelAliases` | 完整的 `provider/model` → 目录型号的对象映射，可用于云平台部署名及其他精确别名 |

### 内置参考价与手动配置

插件保留 `deepseek-official` 路由的高峰期参考价（基于 2026-10-13 官方数据），用于没有有效自动价格时的回退：

- `deepseek-official/deepseek-flash`
- `deepseek-official/deepseek-v4-flash`
- `deepseek-official/deepseek-v4-flash-vision-exp`
- `deepseek-official/deepseek-v4-pro`

如需覆盖同步结果、使用未支持的渠道或补充模型价格：

- 在 **额度设置 → 模型单价** 中手动添加。
- 支持完整的 `provider/model` 精确匹配，或纯 `model` 别名匹配。
- 手动价格的计价单位为 **美元 / 百万 tokens**，不使用人民币来源的汇率设置。
- 若模型缺少单价，或输入无法估算且缺少上下文容量，插件会主动拦截该请求。严格输入预留模式仍要求模型提供上下文容量；请求未指定输出上限不影响插件估算输出预留。

---

## 账本存储与多配置

账本和独立的价格快照默认持久化存储于本地：

```text
$DSH_HOME/quota-plan/ledger.json
$DSH_HOME/quota-plan/prices.json
```
*(未配置 `$DSH_HOME` 时，目录为用户主目录下的 `~/.dsh/quota-plan/`。)*

`ledger.json` 保存额度配置、时间窗口、扣费记录与请求预留；`prices.json` 独立保存同步价格、来源、时间与状态。两者均**不记录提示词正文与 API 密钥**。调整价格来源或同步价格不会改写已结算记录。

已存在的账本若内容损坏或缺少必要字段，插件会停止调用并保留原文件，不会自动重建或清零。进程退出后遗留的账本锁会在后续访问时自动恢复；旧版未写入持有者信息的锁需经过 30 秒宽限期。初始化时暂时无法取得锁，后续请求仍会重试；确认仍在运行的持锁进程不会因锁文件较旧而被抢占。账本目录所在文件系统需支持文件硬链接，以便原子发布完整的锁信息。

### 多 Profile 独立账本
若需要在不同 profile 下分配独立预算，可在对应 profile 的 `cordis.patch.yml` 中指定文件路径：

```yaml
- id: quota-plan
  config:
    dataFile: 'E:/dsh-data/my-plan/ledger.json'
```

价格快照默认随账本放在同一目录，即本例中的 `E:/dsh-data/my-plan/prices.json`。使用不同目录可以隔离各 profile 的价格快照与额度账本。

---

## 本地打包

在项目根目录下执行：

```sh
npm run pack:plugin
```

打包完成后将在当前目录生成 `.tgz` 安装包，可直接通过 DSH 安装：

```sh
dsh plugin --profile web add <生成的tgz包路径>
```

---

## 目录结构

```text
lib/                   额度计算、持久化账本、调用限制与 DSH 接入
lib/prices/            官方公开价格源解析与同步适配
gui/                   Plan 风格前端：仪表盘、百分比进度条、近 7 天趋势与设置面板
cordis.patch.yml       插件注册配置
package.json           插件元信息与依赖声明
README.md              说明文档
LICENSE                MIT 开源协议
THIRD_PARTY_NOTICES.md 第三方开源资产声明
```

---

## 使用须知

1. 本插件仅在本地层面拦截请求并模拟额度消耗，不与 DeepSeek 官方控制台的真实账户扣费产生交互。
2. 停用插件后所有限制失效，你将重新回到那个不会被打断的无趣状态中。
3. 赤石科技仅负责执行额度拦截。至于你的代码最后是否跑通，不在本插件的担保范围之内。

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。  
界面样式与 DSH FishLogo 参考来自 DSH 官方开源组件，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

> 愿下一次调用能够顺利解决问题。如果不能，至少重置时间是确定的。
