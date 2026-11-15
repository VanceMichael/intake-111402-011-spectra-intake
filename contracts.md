# 来源网关契约

GET /run 返回 runId、sourceRevision、spectrumIndex；GET /spectrum/:id 返回 XML 解析投影 id、defaultArrayLength、instrumentConfigurationRef、referenceableParamGroupRef、binaryDataArrays；GET /params/:id 返回 cvParams；GET /offset/:offset 返回该位置实际谱图；GET /sequential?page=1 为顺序读取。数组编码支持 float32/float64 little-endian、none/zlib，使用 accession 判断类型，不以展示名称判断。 GET /instruments/:id 返回运行声明的仪器配置投影。

## 本地来源操作

默认场景 normal，其他场景为 stale-index。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

`collect(client)` 逐条处理 run 索引，返回的每一行都带字符串 id，并保留来源身份：

- `id` 为 `${runId}:${spectrumId}`，`runId`、`sourceRevision`、`spectrumId`、`indexPosition`、`offset`、`arrayLength` 一并保留。
- 随机读取先核对实际对象身份：`/offset/:offset` 返回的 `id`（以及可用的 `runId`）必须与索引条目一致；不一致或读取失败时退回 `/sequential` 顺序读取，绝不把偏移命中的其他谱图挂到当前编号。
- `status` 为 `interpreted`、`partial` 或 `uninterpreted`；`readMode` 记录 `offset`/`index`/`sequential`/`direct`；`sourcePath`、`offsetPath` 保留原件位置。
- 数组解码只按 accession 解释字节：精度 `MS:1000521`/`MS:1000523`，压缩 `MS:1000576`/`MS:1000574`，数组类型 `MS:1000514`/`MS:1000515`。展示名称只记录，不用于猜测类型；缺少精度等声明时该数组不解码并给出原因，不猜字节。
- 参数可来自谱图、数组自身的 `referenceableParamGroupRef` 引用组、或（谱图未声明时）run 级引用组，来源记录在 `parameterGroupSource`。仪器配置经 `/instruments/:id` 解析，前体 `spectrumRef` 解析为 `runSpectrumId`。
- 单条谱图无法解释只影响该行：该行保留 `errors`/`reasons` 和原件位置，其他有效谱图照常返回与归档。

`Archive.put(rows, provenance)` 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。`GET /records` 保留兼容，不将未知状态伪造为成功。
