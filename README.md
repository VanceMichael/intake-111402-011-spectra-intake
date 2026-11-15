# 质谱交付件的谱图索引与数组接收

质谱资料接收器。领取 run 索引并解释每条谱图：解析引用参数组与仪器配置、连接前体引用、按 accession 解码 mz/强度数组。网关保存原始 XML 与 binaryDataArray，只做解析与数组解释，不做峰识别。

## 行为要点

- 数组精度与压缩只按 accession 判断（float32/float64、none/zlib）；缺少声明的字节不解码，记录原因而不是猜类型。
- 参数可来自谱图或数组引用的参数组；谱图未声明仪器/参数组时可继承 run 级声明，并记录继承来源。
- 索引偏移先核对返回对象的 id（及 runId）是否与索引一致；不一致时退回顺序读取，不把其他谱图挂到当前编号。
- 单条谱图读不到或无法解释时，该行保留 `status`、`errors`、`sourcePath`/`offsetPath`，其他有效谱图仍照常交付。


## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

```sh
docker build --network=none -t spectra-intake .
docker run --rm --network=none spectra-intake npm test
docker run --rm --network=none spectra-intake npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；负责索引读取、偏移身份核对、顺序回退与逐谱图装配，不修改来源来迎合适配结果。
- src/spectrum.mjs 解析参数组/仪器/前体引用，并按 accession 解码 binaryDataArray。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
