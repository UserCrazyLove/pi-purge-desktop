# pi-purge —— CLI 扩展参考

[English](cli.md) | [中文](cli.zh-CN.md) | [日本語](cli.ja.md) · [回到首页](../README.zh-CN.md)


[pi](https://github.com/earendil-works/pi-coding-agent) 的系统提示词实验扩展：`/purge` 用来切换一轮会话到底带哪套系统提示词 —— pi 自带的、精简过的，或者只发一份人设提示词。

它的用途是提示词工程：同一句请求在「宿主提示词完整 / 精简 / 缺失」三种条件下的行为差异；自己写的指令做回归测试；以及指令遵循、提示词注入鲁棒性这类受控实验。

关掉时什么都不变：不改提示词、不读盘，行为与没装这个扩展完全一致。

> PI-Desktop 插件版就是这套机制加了一层控制面板。插件安装方式见[首页](../README.zh-CN.md#安装)。

## 安装

```bash
完整带提示词： pi install git:github.com/ZiChuanLan/pi-purge@ffafeb9
自定义提示词： pi install npm:pi-purge
```

然后在会话里：

```text
/purge
```

就这一步。包内自带一段简短示例提示词，装完不必准备任何文件。想换成自己的提示词：

```text
/purge source C:/prompts/my-instructions.md
/purge mode replace
/purge on
```

`/purge source embedded` 切回内置人设。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/purge` | 切换本会话开 / 关 |
| `/purge on` / `off` | 显式开关 |
| `/purge status` | 当前模式、提示词来源、已加载字符数，以及上一轮实际改了什么 |
| `/purge mode append\|replace\|strict` | 切换组合方式（默认 `strict`） |
| `/purge source <路径\|embedded>` | 换提示词文件，或回到内置示例；切换失败会自动回滚 |
| `/purge reload` | 改完外部文件后重新读取 |

## 模式

| 模式 | 实际发给模型的系统提示词 | 适用场景 |
| --- | --- | --- |
| `append` | 你的提示词 + pi 原提示词（一字不改） | 对照组：基线行为，加一层自己的指令 |
| `replace` | 你的提示词 + 去掉「助手身份句」和「内置文档段」的 pi 提示词，工具列表 / Guidelines / 项目上下文保留 | 想测量宿主框架措辞的影响，又不想丢工具上下文 |
| `strict` | 你的提示词 + 仅 `Current working directory: …` | 想把人设/指令当成唯一变量隔离出来。这是默认模式 |

`replace` 依赖固定文案定位那两段。pi 升级改措辞时它会原样保留提示词（退化成 `append`），而不是切错位置 —— `/purge status` 会显示 `身份段 未匹配`。`strict` 不做任何匹配，跨 pi 版本行为一致。omp 传的是提示词块数组，没有这些 pi 专用锚点，`replace` 同样会退化成 `append`；要彻底丢掉宿主框架用 `strict`。

工具 schema 走 API 的 `tools` 参数，不依赖系统提示词，所以三种模式下工具都正常可用，包括 `strict`。

## 会话范围与默认值

- 作用范围是**会话**。每次 `session_start`（启动 / 新建 / `resume` / 重载）都从**关闭**开始；退出 pi 一定回到原始提示词。
- **不写任何文件**：没有状态文件、没有缓存、没有标记。两个 pi 进程互不影响。
- 默认提示词是 `extensions/pi-purge.ts` 里的一小段示例；`/purge source <路径>` 换成自己的文件，`/purge source embedded` 切回来。
- 想不落盘就让每次启动都指向自己的文件，把 `PI_PURGE_SOURCE` 设成绝对路径：

    ```bash
    PI_PURGE_SOURCE=/home/me/persona.md pi          # macOS / Linux
    set PI_PURGE_SOURCE=C:/prompts/persona.md        # Windows cmd
    $env:PI_PURGE_SOURCE='C:/prompts/persona.md'     # Windows PowerShell
    ```

    它只提供 `source` 的初始值：仍然要 `/purge on`，每次 `session_start` 的 `enabled` 仍然是 `false`，会话里的 `/purge source <路径>` 也仍然优先。文件不存在时 `/purge on` 会报错，而不是静默回退到内嵌示例。
- 内置文本故意写得很短：发布到包仓库的内容会被扫描滥用性提示词，完整的人设文本过不了扫描；把自己的提示词放在本地用 `/purge source` 引用。
- 默认模式 `strict`。

## 从 0.1.x 升级

0.2 不再读写 `pi-purge.json`，也不再自动探测提示词文件 —— 人设内置，模式默认 `strict`。

- 删掉 `<agent dir>/pi-purge.json`，它已经不被读取。
- 开启是会话级的：重启或 `/resume` 之后需要重新 `/purge`。
- 需要时 `append` / `replace` 的行为与之前一致。

## 做实验时的注意点

- `strict` 会一并丢掉 `AGENTS.md` / 项目上下文、skills 列表、其他扩展注入的提示词。这正是它能做单变量隔离的原因，也意味着 `strict` 下的结论不能直接和普通会话对比。
- `append` 侵入最小、信号也最弱：宿主提示词后段权重仍然很大，差异可能不明显。
- `replace` 仍会残留宿主文本，而且其他扩展可能在本扩展之后追加自己的提示词段。实践上只有 `strict` 能让人设不和别的框架措辞竞争。
- 扩展加载顺序会影响 `before_agent_start` 看到的内容。要留结果的话，建议把 `/purge status` 的输出一起记录。

## 开发

```bash
npm test   # 两个套件，均跑在临时 agent 目录里，并断言全程没有写任何文件
```

实现上只注册一个 `before_agent_start` 钩子、一个 `session_start` 钩子和一个 `/purge` 命令，无其他钩子、无后台任务、无文件写入。

## 致谢与署名

本项目的机制移植自 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)：把宿主身份段**清掉**（而非压住）的思路、三档组合方式与默认提示词，均出自该项目。按原作者要求在此署名并标明来源仓库。
